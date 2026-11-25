/**
 * Client de l'API Modrinth (https://docs.modrinth.com/api/) : recherche, projets, versions,
 * identification des fichiers installés et recherche de mises à jour.
 *
 * Modrinth est sollicité le moins possible :
 *  - réponses GET gardées en mémoire (10 à 30 min) et requêtes identiques en cours mutualisées ;
 *  - 4 requêtes simultanées au maximum, attente automatique en cas de limite atteinte (HTTP 429) ;
 *  - cache disque (`<userData>/modrinth-cache.json`) pour ce qui coûte le plus :
 *      sha1 des fichiers (tant que le fichier ne change pas), fichier → version Modrinth (7 jours,
 *      1 jour si inconnu), dernières versions disponibles (6 heures).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nodeFetch = require('node-fetch');
const { ipcRenderer } = require('electron');

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'Venstone-Launcher';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Durées de vie des caches. */
const TTL = {
    search: 10 * MINUTE,
    project: 30 * MINUTE,
    versions: 15 * MINUTE,
    identified: 7 * DAY,
    unknown: DAY,
    updates: 6 * HOUR
};

/** Types de projet Modrinth par type de contenu du launcher. */
export const PROJECT_TYPES = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', modpacks: 'modpack' };

/** Identifiant Modrinth de Fabric API (installée par le launcher si l'instance le demande). */
export const FABRIC_API_ID = 'P7dR8mSH';

/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */

const MAX_PARALLEL = 4;
let running = 0;
let waiting = [];
let pausedUntil = 0;

/** Exécute `task` en respectant la limite de requêtes simultanées. */
async function limited(task) {
    if (running >= MAX_PARALLEL) await new Promise(resolve => waiting.push(resolve));
    running++;
    try {
        let pause = pausedUntil - Date.now();
        if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
        return await task();
    } finally {
        running--;
        waiting.shift()?.();
    }
}

/**
 * Appel brut à l'API.
 * @param {string} route Chemin après /v2 (avec la query string)
 * @param {{method?: string, body?: object}} [options]
 */
async function call(route, { method = 'GET', body } = {}) {
    return limited(async () => {
        for (let attempt = 0; ; attempt++) {
            let res = await nodeFetch(`${API}${route}`, {
                method,
                timeout: 15000,
                headers: { 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined
            });
            if (res.status === 429 && attempt === 0) {
                // Limite atteinte : on attend la fin de la fenêtre indiquée (10 s au plus).
                let reset = Math.min(10, Number(res.headers.get('x-ratelimit-reset')) || 5);
                pausedUntil = Date.now() + reset * 1000;
                await new Promise(resolve => setTimeout(resolve, reset * 1000));
                continue;
            }
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`Modrinth a répondu ${res.status}`);
            return res.json();
        }
    });
}

let memory = new Map();

/**
 * GET mis en cache en mémoire. Deux appels identiques simultanés ne font qu'une requête.
 * @param {string} route
 * @param {number} ttl
 */
function cachedGet(route, ttl) {
    let hit = memory.get(route);
    if (hit && Date.now() - hit.time < ttl) return hit.promise;
    let promise = call(route).catch(err => { memory.delete(route); throw err; });
    memory.set(route, { time: Date.now(), promise });
    if (memory.size > 300) memory.delete(memory.keys().next().value);
    return promise;
}

/** Paramètre de requête JSON (`["a","b"]`). */
const q = value => encodeURIComponent(JSON.stringify(value));

/* ------------------------------------------------------------------ */
/* Cache disque                                                        */
/* ------------------------------------------------------------------ */

let disk = null;
let diskFile = null;
let saveTimer = null;

/** Charge le cache disque (une fois) en écartant les entrées expirées. */
async function store() {
    if (disk) return disk;
    diskFile = path.join(await ipcRenderer.invoke('path-user-data'), 'modrinth-cache.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(diskFile, 'utf8')); } catch { }
    let now = Date.now();
    let fresh = (table, ttl) => Object.fromEntries(Object.entries(table || {}).filter(([, v]) => v && now - v.time < ttl(v)));
    disk = {
        sha1: data.sha1 || {},
        files: fresh(data.files, v => (v.version ? TTL.identified : TTL.unknown)),
        updates: fresh(data.updates, () => TTL.updates)
    };
    return disk;
}

/** Enregistre le cache disque (regroupé : au plus une écriture toutes les 2 s). */
function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 2000);
}

function saveNow() {
    clearTimeout(saveTimer);
    try {
        fs.writeFileSync(`${diskFile}.tmp`, JSON.stringify(disk));
        fs.renameSync(`${diskFile}.tmp`, diskFile);
    } catch (err) {
        console.warn('[Modrinth] cache non enregistré :', err.message);
    }
}

/**
 * Taille du cache (pour les paramètres).
 * @returns {Promise<{files: number, updates: number}>}
 */
export async function cacheStats() {
    let cache = await store();
    return { files: Object.keys(cache.files).length, updates: Object.keys(cache.updates).length };
}

/**
 * Vide tout ce que le launcher a gardé des réponses de Modrinth : la prochaine ouverture d'une
 * instance redemande les dernières versions. Les empreintes des fichiers locaux sont conservées
 * (elles ne dépendent pas de Modrinth et coûtent cher à recalculer).
 */
export async function clearCache() {
    let cache = await store();
    cache.files = {};
    cache.updates = {};
    memory.clear();
    projects.clear();
    saveNow();
}

/* ------------------------------------------------------------------ */
/* Compatibilité                                                       */
/* ------------------------------------------------------------------ */

/**
 * Loaders Modrinth à demander pour un type de contenu dans une instance.
 * @param {"mods"|"resourcepacks"|"shaderpacks"} kind
 * @param {object} instance
 * @param {{id: string}|null} [shaderLoader] Mod de shaders installé (Iris, Oculus, OptiFine)
 * @returns {string[]}
 */
export function contentLoaders(kind, instance, shaderLoader = null) {
    let { loadder_type: type = 'none', minecraft_version: mc } = instance?.loadder || {};
    if (kind === 'resourcepacks') return ['minecraft'];
    if (kind === 'shaderpacks') {
        if (shaderLoader?.id === 'optifine') return ['optifine'];
        return shaderLoader ? ['iris'] : ['iris', 'optifine'];
    }
    // Quilt charge aussi les mods Fabric ; NeoForge 1.20.1 charge les mods Forge.
    let loaders = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge'] }[type] || [];
    if (type === 'neoforge' && mc === '1.20.1') loaders.push('forge');
    return loaders;
}

/**
 * Meilleure version d'une liste (déjà filtrée) : la plus récente des versions stables,
 * sinon la plus récente tout court.
 * @param {object[]} versions
 */
export function bestVersion(versions) {
    let sorted = [...(versions || [])].sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
    return sorted.find(v => v.version_type === 'release') || sorted[0] || null;
}

/** Fichier principal d'une version. */
export function primaryFile(version) {
    return version?.files?.find(f => f.primary) || version?.files?.[0] || null;
}

/* ------------------------------------------------------------------ */
/* Recherche, projets et versions                                      */
/* ------------------------------------------------------------------ */

/**
 * Recherche de projets.
 * @param {object} options
 * @param {"mods"|"resourcepacks"|"shaderpacks"|"modpacks"} options.kind
 * @param {string} [options.query]
 * @param {"relevance"|"downloads"|"follows"|"newest"|"updated"} [options.sort]
 * @param {string[]} [options.loaders] Catégories de loader acceptées (OU)
 * @param {string} [options.gameVersion]
 * @param {number} [options.offset]
 * @param {number} [options.limit]
 * @returns {Promise<{hits: object[], total_hits: number, offset: number}>}
 */
export function search({ kind, query = '', sort = 'relevance', loaders = [], gameVersion = null, offset = 0, limit = 20 }) {
    let facets = [[`project_type:${PROJECT_TYPES[kind]}`]];
    // « minecraft » n'est pas une catégorie de recherche (les packs de textures n'ont pas de loader).
    let categories = loaders.filter(l => l !== 'minecraft');
    if (categories.length) facets.push(categories.map(l => `categories:${l}`));
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    let params = `query=${encodeURIComponent(query)}&index=${sort}&offset=${offset}&limit=${limit}&facets=${q(facets)}`;
    return cachedGet(`/search?${params}`, TTL.search);
}

let projects = new Map();

/**
 * Projets par identifiant (une seule requête pour tous ceux qui ne sont pas en cache).
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>}
 */
export async function getProjects(ids) {
    let now = Date.now();
    let missing = [...new Set(ids)].filter(id => !(projects.get(id) && now - projects.get(id).time < TTL.project));
    for (let i = 0; i < missing.length; i += 100) {
        let list = await call(`/projects?ids=${q(missing.slice(i, i + 100))}`) || [];
        for (let p of list) {
            projects.set(p.id, { time: now, data: p });
            projects.set(p.slug, { time: now, data: p });
        }
    }
    return new Map(ids.map(id => [id, projects.get(id)?.data]).filter(([, p]) => p));
}

/**
 * Versions d'un projet, éventuellement filtrées (loaders, version du jeu).
 * @param {string} id Identifiant ou slug
 * @param {{loaders?: string[], gameVersions?: string[]}} [filter]
 * @returns {Promise<object[]>} Plus récentes d'abord
 */
export async function projectVersions(id, { loaders = [], gameVersions = [] } = {}) {
    let params = [];
    if (loaders.length) params.push(`loaders=${q(loaders)}`);
    if (gameVersions.length) params.push(`game_versions=${q(gameVersions)}`);
    let list = await cachedGet(`/project/${encodeURIComponent(id)}/version${params.length ? `?${params.join('&')}` : ''}`, TTL.versions);
    return list || [];
}

/**
 * Versions par identifiant.
 * @param {string[]} ids
 * @returns {Promise<object[]>}
 */
export async function getVersions(ids) {
    if (!ids.length) return [];
    return (await cachedGet(`/versions?ids=${q([...new Set(ids)].sort())}`, TTL.versions)) || [];
}

/* ------------------------------------------------------------------ */
/* Fichiers installés                                                  */
/* ------------------------------------------------------------------ */

/**
 * sha1 d'un fichier, recalculé seulement s'il a changé (taille ou date).
 * @param {string} file
 * @returns {Promise<string|null>} null pour un dossier
 */
export async function sha1File(file) {
    let cache = await store();
    let stat = await fs.promises.stat(file);
    if (!stat.isFile()) return null;
    let key = `${path.resolve(file)}|${stat.size}|${Math.round(stat.mtimeMs)}`;
    if (cache.sha1[key]) return cache.sha1[key];
    let hash = crypto.createHash('sha1').update(await fs.promises.readFile(file)).digest('hex');
    // Une seule entrée par fichier : l'ancienne empreinte est oubliée.
    let prefix = `${path.resolve(file)}|`;
    for (let k of Object.keys(cache.sha1)) if (k.startsWith(prefix)) delete cache.sha1[k];
    cache.sha1[key] = hash;
    saveSoon();
    return hash;
}

/**
 * Identifie des fichiers sur Modrinth.
 * @param {string[]} files Chemins
 * @returns {Promise<Map<string, {sha1: string, version: object|null}>>} chemin → version Modrinth installée
 */
export async function identify(files) {
    let cache = await store();
    let hashes = new Map();
    for (let file of files) {
        try {
            let sha1 = await sha1File(file);
            if (sha1) hashes.set(file, sha1);
        } catch { /* fichier disparu entre-temps */ }
    }

    let unknown = [...new Set(hashes.values())].filter(h => !cache.files[h]);
    if (unknown.length) {
        let found = await call('/version_files', { method: 'POST', body: { hashes: unknown, algorithm: 'sha1' } }) || {};
        let now = Date.now();
        for (let h of unknown) cache.files[h] = { time: now, version: found[h] ? slimVersion(found[h]) : null };
        saveSoon();
    }
    return new Map([...hashes].map(([file, sha1]) => [file, { sha1, version: cache.files[sha1]?.version || null }]));
}

/**
 * Dernières versions compatibles des fichiers donnés, par rapport à leur version installée.
 * @param {string[]} files Chemins
 * @param {{loaders: string[], gameVersion: string, force?: boolean}} options `force` ignore le cache
 * @returns {Promise<Map<string, {current: object, latest: object}>>} Seulement les fichiers à mettre à jour
 */
export async function findUpdates(files, { loaders, gameVersion, force = false }) {
    let cache = await store();
    let known = [...(await identify(files))].filter(([, v]) => v.version);
    let keyOf = sha1 => `${sha1}|${loaders.join(',')}|${gameVersion}`;

    let toAsk = [...new Set(known.map(([, v]) => v.sha1))].filter(h => force || !cache.updates[keyOf(h)]);
    if (toAsk.length) {
        let latest = await call('/version_files/update', {
            method: 'POST',
            body: { hashes: toAsk, algorithm: 'sha1', loaders, game_versions: [gameVersion] }
        }) || {};
        // Modrinth renvoie la toute dernière version, bêta comprise : une installation stable
        // reste sur les versions stables (liste du projet, déjà en cache s'il a été consulté).
        let currentOf = new Map(known.map(([, v]) => [v.sha1, v.version]));
        for (let h of toAsk) {
            let current = currentOf.get(h);
            if (latest[h] && latest[h].version_type !== 'release' && current.version_type === 'release') {
                let stable = bestVersion(await projectVersions(current.project_id, { loaders, gameVersions: [gameVersion] }));
                latest[h] = stable?.version_type === 'release' ? stable : null;
            }
        }
        let now = Date.now();
        for (let h of toAsk) cache.updates[keyOf(h)] = { time: now, version: latest[h] ? slimVersion(latest[h]) : null };
        saveSoon();
    }

    let out = new Map();
    for (let [file, { sha1, version: current }] of known) {
        let latest = cache.updates[keyOf(sha1)]?.version;
        // Plus récente que celle installée (jamais de retour en arrière).
        if (latest && latest.id !== current.id && new Date(latest.date_published) > new Date(current.date_published)) {
            out.set(file, { current, latest });
        }
    }
    return out;
}

/** Garde l'essentiel d'une version pour le cache disque. */
function slimVersion(v) {
    return {
        id: v.id,
        project_id: v.project_id,
        name: v.name,
        version_number: v.version_number,
        version_type: v.version_type,
        date_published: v.date_published,
        loaders: v.loaders,
        game_versions: v.game_versions,
        dependencies: v.dependencies || [],
        files: (v.files || []).map(f => ({ url: f.url, filename: f.filename, primary: f.primary, size: f.size, hashes: f.hashes }))
    };
}

/* ------------------------------------------------------------------ */
/* Dépendances                                                         */
/* ------------------------------------------------------------------ */

/**
 * Prépare l'installation de versions : dépendances requises à ajouter (récursivement),
 * dépendances introuvables pour cette instance, et conflits avec ce qui est installé.
 * @param {object[]} versions Versions à installer
 * @param {object} context
 * @param {string[]} context.loaders
 * @param {string} context.gameVersion
 * @param {Set<string>} context.installed Projets Modrinth déjà installés
 * @returns {Promise<{dependencies: object[], missing: string[], conflicts: string[], optional: object[]}>}
 *          `dependencies` : versions à installer en plus, les plus profondes d'abord
 */
export async function resolveDependencies(versions, { loaders, gameVersion, installed }) {
    let planned = new Set(versions.map(v => v.project_id));
    let dependencies = [];
    let missing = [];
    let conflicts = new Set();
    let optional = new Set();
    let queue = [...versions];

    while (queue.length) {
        let version = queue.shift();
        let deps = (version.dependencies || []).filter(d => d.project_id || d.version_id);
        // Dépendance donnée seulement par sa version : on retrouve son projet.
        let byVersion = deps.filter(d => !d.project_id).map(d => d.version_id);
        let resolved = new Map((await getVersions(byVersion)).map(v => [v.id, v]));
        for (let d of deps) if (!d.project_id) d.project_id = resolved.get(d.version_id)?.project_id;

        for (let dep of deps.filter(d => d.project_id)) {
            if (dep.dependency_type === 'incompatible' && installed.has(dep.project_id)) conflicts.add(dep.project_id);
            if (dep.dependency_type === 'optional' && !installed.has(dep.project_id)) optional.add(dep.project_id);
            if (dep.dependency_type !== 'required' || installed.has(dep.project_id) || planned.has(dep.project_id)) continue;
            planned.add(dep.project_id);

            let candidates = await projectVersions(dep.project_id, { loaders, gameVersions: [gameVersion] });
            let pinned = dep.version_id && candidates.find(v => v.id === dep.version_id);
            let chosen = pinned || bestVersion(candidates);
            if (!chosen) { missing.push(dep.project_id); continue; }
            dependencies.unshift(chosen);
            queue.push(chosen);
        }
    }

    let names = await getProjects([...missing, ...conflicts, ...optional, ...dependencies.map(v => v.project_id)]);
    let title = id => names.get(id)?.title || id;
    for (let v of dependencies) v.project_title = title(v.project_id);
    return {
        dependencies,
        missing: missing.map(title),
        conflicts: [...conflicts].map(title),
        optional: [...optional].filter(id => !planned.has(id)).map(id => names.get(id)).filter(Boolean)
    };
}

/* ------------------------------------------------------------------ */
/* Téléchargement                                                      */
/* ------------------------------------------------------------------ */

/**
 * Dossier temporaire pour des téléchargements (à supprimer avec `fs.rmSync(dir, {recursive})`).
 * @returns {string}
 */
export function tempFolder() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'venstone-modrinth-'));
}

/**
 * Télécharge le fichier principal d'une version et vérifie son sha1.
 * @param {object} version
 * @param {string} dir Dossier de destination
 * @returns {Promise<string>} Chemin du fichier
 */
export async function downloadVersion(version, dir) {
    let file = primaryFile(version);
    if (!file?.url) throw new Error(`Aucun fichier pour ${version.name || version.version_number}`);
    let name = path.basename(file.filename);
    let res = await nodeFetch(file.url, { timeout: 120000, headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`${name} : HTTP ${res.status}`);
    let data = await res.buffer();
    if (file.hashes?.sha1 && crypto.createHash('sha1').update(data).digest('hex') !== file.hashes.sha1) {
        throw new Error(`${name} : fichier corrompu (sha1 invalide)`);
    }
    let target = path.join(dir, name);
    await fs.promises.writeFile(target, data);
    return target;
}

/* ------------------------------------------------------------------ */
/* Affichage                                                           */
/* ------------------------------------------------------------------ */

/** Nombre compact (« 1,2 M », « 34 k »). */
export function compactNumber(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',')} M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',')} k`;
    return String(n);
}

/** Date relative (« il y a 3 jours »). */
export function relativeDate(date) {
    let days = Math.floor((Date.now() - new Date(date)) / DAY);
    if (days < 1) return "aujourd'hui";
    if (days < 30) return `il y a ${days} jour${days > 1 ? 's' : ''}`;
    let months = Math.floor(days / 30);
    if (months < 12) return `il y a ${months} mois`;
    let years = Math.floor(days / 365);
    return `il y a ${years} an${years > 1 ? 's' : ''}`;
}
