/**
 * Modpacks au format Modrinth (.mrpack) : export d'une instance et import dans une nouvelle
 * instance personnelle.
 *
 * Un .mrpack est un zip contenant :
 *  - modrinth.index.json : version du jeu, loader, et fichiers à télécharger depuis Modrinth ;
 *  - overrides/ (et client-overrides/) : fichiers copiés tels quels dans l'instance.
 * Spécification : https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */

import { listZip, readZipEntry, ZipWriter } from './zip.js';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodeFetch = require('node-fetch');

const USER_AGENT = 'Venstone-Launcher';
const INDEX = 'modrinth.index.json';

/** Domaines de téléchargement autorisés par la spécification (les autres sont signalés). */
const TRUSTED_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];

/** Entrées d'instance jamais proposées à l'export (données locales, partagées ou générées). */
const EXPORT_HIDDEN = new Set([
    'saves', 'screenshots', 'logs', 'crash-reports', 'downloads', '.fabric', '.quilt', '.mixin.out', '.cache',
    '.venstone-shared', 'servers.dat', 'servers.dat_old', 'servers.dat.avant-partage',
    'usercache.json', 'usernamecache.json', 'command_history.txt', 'realms_persistence.json'
]);

/** Entrées cochées par défaut, comme sur Modrinth. */
const EXPORT_DEFAULT = new Set(['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'kubejs']);

/** Fichiers recherchés sur Modrinth (téléchargés à l'import au lieu d'être inclus dans le pack). */
const LINKABLE = /^(mods|resourcepacks|shaderpacks)\/[^/]+\.(jar|zip)$/i;

/** Clés de dépendance du format ↔ loaders du launcher. */
const LOADER_KEYS = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/**
 * Résout un chemin relatif dans l'instance, en refusant toute sortie du dossier
 * (« ../ », chemin absolu) : un pack ne doit jamais écrire ailleurs.
 * @param {string} dir
 * @param {string} rel
 * @returns {string|null}
 */
export function safeJoin(dir, rel) {
    let clean = String(rel || '').split('\\').join('/');
    if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return null;
    if (clean.split('/').some(part => part === '..')) return null;
    let root = path.resolve(dir);
    let target = path.resolve(root, clean);
    return target.startsWith(root + path.sep) ? target : null;
}

/**
 * Taille lisible (« 12,4 Mo »).
 * @param {number} bytes
 */
export function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} o`;
    let units = ['Ko', 'Mo', 'Go'];
    let value = bytes;
    let unit = -1;
    do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value < 10 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
}

/**
 * Exécute `worker` sur chaque élément, `limit` à la fois.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 */
async function parallel(items, limit, worker) {
    let next = 0;
    let run = async () => {
        while (next < items.length) await worker(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Contenu exportable d'une instance : entrées de premier niveau et, pour les dossiers,
 * leurs entrées directes (pour choisir finement, comme sur Modrinth).
 * @param {string} dir Dossier de l'instance
 * @returns {Array<{name: string, dir: boolean, checked: boolean, children: Array<{name: string, dir: boolean}>}>}
 */
export function exportTree(dir) {
    if (!fs.existsSync(dir)) return [];
    let list = entries => entries
        .filter(e => !e.isSymbolicLink() && (e.isFile() || e.isDirectory()))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return list(fs.readdirSync(dir, { withFileTypes: true }))
        .filter(e => !EXPORT_HIDDEN.has(e.name))
        .map(e => {
            let children = [];
            if (e.isDirectory()) {
                try {
                    children = list(fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }))
                        .map(c => ({ name: c.name, dir: c.isDirectory() }));
                } catch { }
            }
            return { name: e.name, dir: e.isDirectory(), checked: EXPORT_DEFAULT.has(e.name), children };
        });
}

/**
 * Fichiers (chemins relatifs « / ») contenus dans les chemins sélectionnés, sans suivre les liens.
 * @param {string} dir
 * @param {string[]} selection Chemins relatifs (fichiers ou dossiers)
 * @returns {string[]}
 */
function collectFiles(dir, selection) {
    let out = new Set();
    let walk = rel => {
        let abs = path.join(dir, rel);
        let stat;
        try { stat = fs.lstatSync(abs); } catch { return; }
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) return out.add(rel.split(path.sep).join('/'));
        if (stat.isDirectory()) {
            for (let name of fs.readdirSync(abs)) walk(path.join(rel, name));
        }
    };
    for (let rel of selection) {
        if (safeJoin(dir, rel)) walk(rel);
    }
    return [...out].sort();
}

/**
 * Cherche des fichiers sur Modrinth par leur sha1.
 * @param {string[]} hashes
 * @returns {Promise<Object<string, object>>} sha1 → version Modrinth
 */
async function lookupModrinth(hashes) {
    if (!hashes.length) return {};
    let res = await nodeFetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        timeout: 20000,
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes, algorithm: 'sha1' })
    });
    if (!res.ok) throw new Error(`Modrinth : HTTP ${res.status}`);
    return res.json();
}

/**
 * Dépendances du format (« minecraft », « fabric-loader »...) d'une instance.
 * @param {object} instance
 */
export function instanceDependencies(instance) {
    let { minecraft_version: mc, loadder_type: type = 'none', loadder_version: build } = instance.loadder || {};
    let deps = { minecraft: mc };
    if (LOADER_KEYS[type] && build && build !== 'latest') {
        deps[LOADER_KEYS[type]] = String(build).replace(`${mc}-`, '');
    }
    return deps;
}

/**
 * Exporte une instance en .mrpack.
 * Les mods / packs trouvés sur Modrinth sont référencés (téléchargés à l'import) ; tout le
 * reste est inclus dans overrides/.
 * @param {object} options
 * @param {object} options.instance
 * @param {string} options.dir Dossier de l'instance
 * @param {string} options.output Fichier .mrpack à créer
 * @param {string} options.name
 * @param {string} options.version
 * @param {string} [options.summary]
 * @param {string[]} options.selection Chemins relatifs à inclure
 * @param {(text: string) => void} [options.onProgress]
 * @returns {Promise<{files: number, linked: number, included: number, offline: boolean, size: number}>}
 */
export async function exportModpack({ instance, dir, output, name, version, summary = '', selection, onProgress = () => { } }) {
    onProgress('Analyse des fichiers...');
    let files = collectFiles(dir, selection);
    if (!files.length) throw new Error('Aucun fichier sélectionné.');

    // Hachage des mods / packs puis recherche sur Modrinth.
    let candidates = files.filter(f => LINKABLE.test(f));
    let hashes = new Map();
    for (let [i, rel] of candidates.entries()) {
        onProgress(`Analyse des mods... ${i + 1}/${candidates.length}`);
        let data = await fs.promises.readFile(path.join(dir, rel));
        hashes.set(rel, {
            sha1: crypto.createHash('sha1').update(data).digest('hex'),
            sha512: crypto.createHash('sha512').update(data).digest('hex'),
            size: data.length
        });
    }

    let found = {};
    let offline = false;
    if (hashes.size) {
        onProgress('Recherche des fichiers sur Modrinth...');
        try {
            found = await lookupModrinth([...hashes.values()].map(h => h.sha1));
        } catch (err) {
            console.warn('[mrpack] Modrinth injoignable, tous les fichiers seront inclus :', err.message);
            offline = true;
        }
    }

    let indexFiles = [];
    let overrides = [];
    for (let rel of files) {
        let hash = hashes.get(rel);
        let match = hash && found[hash.sha1]?.files?.find(f => f.hashes?.sha1 === hash.sha1);
        if (match?.url) {
            indexFiles.push({
                path: rel,
                hashes: { sha1: hash.sha1, sha512: match.hashes.sha512 || hash.sha512 },
                downloads: [match.url],
                fileSize: hash.size
            });
        } else {
            overrides.push(rel);
        }
    }

    let index = {
        formatVersion: 1,
        game: 'minecraft',
        versionId: version,
        name,
        ...(summary ? { summary } : {}),
        files: indexFiles,
        dependencies: instanceDependencies(instance)
    };

    let tmp = `${output}.tmp`;
    let zip = await ZipWriter.create(tmp);
    try {
        await zip.add(INDEX, Buffer.from(JSON.stringify(index, null, 2)));
        for (let [i, rel] of overrides.entries()) {
            onProgress(`Création du modpack... ${i + 1}/${overrides.length}`);
            let abs = path.join(dir, rel);
            let [data, stat] = await Promise.all([fs.promises.readFile(abs), fs.promises.stat(abs)]);
            await zip.add(`overrides/${rel}`, data, stat.mtime);
        }
        await zip.close();
        await fs.promises.rm(output, { force: true });
        await fs.promises.rename(tmp, output);
    } catch (err) {
        await zip.abort();
        await fs.promises.rm(tmp, { force: true });
        throw err;
    }

    return {
        files: files.length,
        linked: indexFiles.length,
        included: overrides.length,
        offline,
        size: (await fs.promises.stat(output)).size
    };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Loader du launcher correspondant aux dépendances d'un pack.
 * @param {object} deps
 * @returns {{minecraft_version: string, loadder_type: string, loadder_version: string}}
 */
export function loaderFromDependencies(deps = {}) {
    let mc = deps.minecraft;
    if (!mc) throw new Error('Version de Minecraft absente du modpack.');
    for (let [type, key] of Object.entries(LOADER_KEYS)) {
        let build = deps[key];
        if (!build) continue;
        build = String(build);
        // Le launcher nomme les builds Forge « 1.20.1-47.2.0 » (et NeoForge 1.20.1 aussi).
        if ((type === 'forge' || (type === 'neoforge' && mc === '1.20.1')) && !build.startsWith(`${mc}-`)) build = `${mc}-${build}`;
        return { minecraft_version: mc, loadder_type: type, loadder_version: build };
    }
    return { minecraft_version: mc, loadder_type: 'none', loadder_version: 'latest' };
}

/**
 * Lit et vérifie un .mrpack avant import.
 * @param {string} file
 * @returns {Promise<{file: string, index: object, entries: object[], name: string, version: string, summary: string, loadder: object, downloads: object[], skipped: number, overrides: number, size: number, foreignHosts: string[]}>}
 */
export async function readModpack(file) {
    let entries = await listZip(file);
    let entry = entries.find(e => e.name === INDEX);
    if (!entry && entries.some(e => e.name === 'manifest.json')) {
        throw new Error("Ce modpack vient de CurseForge. Seul le format Modrinth est pris en charge : cherchez-le sur Modrinth, ou exportez-le en .mrpack depuis un autre launcher.");
    }
    if (!entry) throw new Error("Ce fichier n'est pas un modpack Modrinth (modrinth.index.json introuvable).");

    let index;
    try {
        index = JSON.parse((await readZipEntry(file, entry)).toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new Error('modrinth.index.json est illisible.');
    }
    if (index.game !== 'minecraft') throw new Error(`Jeu non pris en charge : ${index.game}`);
    if (index.formatVersion !== 1) throw new Error(`Version du format non prise en charge : ${index.formatVersion}`);
    let loadder = loaderFromDependencies(index.dependencies);

    let all = Array.isArray(index.files) ? index.files : [];
    // Fichiers uniquement serveur : ignorés par un client.
    let downloads = all.filter(f => f?.env?.client !== 'unsupported');
    let foreignHosts = new Set();
    for (let f of downloads) {
        if (!f.path || !f.hashes?.sha1 || !Array.isArray(f.downloads) || !f.downloads.length) {
            throw new Error(`Entrée invalide dans le modpack : ${f.path || '(sans chemin)'}`);
        }
        for (let url of f.downloads) {
            let host;
            try { host = new URL(url).hostname; } catch { throw new Error(`Lien invalide pour ${f.path}`); }
            if (!/^https:/i.test(url)) throw new Error(`Lien non sécurisé (http) pour ${f.path}`);
            if (!TRUSTED_HOSTS.includes(host)) foreignHosts.add(host);
        }
    }

    let overrides = entries.filter(e => !e.dir && /^(client-)?overrides\//.test(e.name));
    return {
        file,
        index,
        entries,
        name: String(index.name || path.basename(file, path.extname(file))),
        version: String(index.versionId || ''),
        summary: String(index.summary || ''),
        loadder,
        downloads,
        skipped: all.length - downloads.length,
        overrides: overrides.length,
        size: downloads.reduce((s, f) => s + (Number(f.fileSize) || 0), 0),
        foreignHosts: [...foreignHosts]
    };
}

/**
 * Télécharge un fichier du pack (essaie chaque lien) et vérifie son sha1 / sha512.
 * @param {object} f Entrée de `files`
 * @param {string} target
 */
async function downloadFile(f, target) {
    let lastError = null;
    for (let url of f.downloads) {
        try {
            let res = await nodeFetch(url, { timeout: 60000, headers: { 'User-Agent': USER_AGENT } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            let data = await res.buffer();
            if (crypto.createHash('sha1').update(data).digest('hex') !== String(f.hashes.sha1).toLowerCase()) throw new Error('sha1 invalide');
            if (f.hashes.sha512 && crypto.createHash('sha512').update(data).digest('hex') !== String(f.hashes.sha512).toLowerCase()) throw new Error('sha512 invalide');
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.writeFile(target, data);
            return;
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(`${path.basename(f.path)} : ${lastError?.message || 'téléchargement impossible'}`);
}

/**
 * Installe le contenu d'un pack (lu par `readModpack`) dans le dossier d'une instance :
 * téléchargements puis overrides/ et client-overrides/ (prioritaires).
 * @param {object} pack
 * @param {string} dir Dossier de l'instance (créé)
 * @param {(text: string) => void} [onProgress]
 */
export async function installModpack(pack, dir, onProgress = () => { }) {
    await fs.promises.mkdir(dir, { recursive: true });

    let done = 0;
    let total = pack.downloads.length;
    onProgress(`Téléchargement des fichiers... 0/${total}`);
    await parallel(pack.downloads, 6, async f => {
        let target = safeJoin(dir, f.path);
        if (!target) throw new Error(`Chemin refusé dans le modpack : ${f.path}`);
        await downloadFile(f, target);
        onProgress(`Téléchargement des fichiers... ${++done}/${total}`);
    });

    let overrides = pack.entries.filter(e => !e.dir && e.name.startsWith('overrides/'));
    let client = pack.entries.filter(e => !e.dir && e.name.startsWith('client-overrides/'));
    let list = [...overrides, ...client];
    for (let [i, entry] of list.entries()) {
        onProgress(`Copie des fichiers du modpack... ${i + 1}/${list.length}`);
        let rel = entry.name.replace(/^(client-)?overrides\//, '');
        let target = safeJoin(dir, rel);
        if (!target) continue;
        let data = await readZipEntry(pack.file, entry);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, data);
    }
}
