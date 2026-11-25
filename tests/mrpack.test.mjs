import { tempDir } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZipWriter } from '../src/assets/js/utils/zip.js';
import { safeJoin, loaderFromDependencies, instanceDependencies, readModpack, installModpack, updateModpack, exportTree } from '../src/assets/js/utils/mrpack.js';

/** Crée un .mrpack de test. */
async function makePack(index, extra = {}) {
    let file = path.join(tempDir(), 'pack.mrpack');
    let zip = await ZipWriter.create(file);
    if (index) await zip.add('modrinth.index.json', Buffer.from(JSON.stringify(index)));
    for (let [name, content] of Object.entries(extra)) await zip.add(name, Buffer.from(content));
    await zip.close();
    return file;
}

const BASE = { formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Pack', files: [], dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' } };

test('safeJoin refuse toute sortie du dossier', () => {
    let dir = tempDir();
    assert.equal(safeJoin(dir, '../x'), null);
    assert.equal(safeJoin(dir, 'a/../../x'), null);
    assert.equal(safeJoin(dir, '/etc/passwd'), null);
    assert.equal(safeJoin(dir, 'C:/Windows/x'), null);
    assert.equal(safeJoin(dir, ''), null);
    assert.equal(safeJoin(dir, 'mods/a.jar'), path.join(dir, 'mods', 'a.jar'));
});

test('loader du launcher depuis les dépendances', () => {
    assert.deepEqual(loaderFromDependencies({ minecraft: '1.21.1', 'fabric-loader': '0.16.14' }),
        { minecraft_version: '1.21.1', loadder_type: 'fabric', loadder_version: '0.16.14' });
    assert.equal(loaderFromDependencies({ minecraft: '1.20.1', forge: '47.2.0' }).loadder_version, '1.20.1-47.2.0');
    assert.equal(loaderFromDependencies({ minecraft: '1.20.1', neoforge: '47.1.106' }).loadder_version, '1.20.1-47.1.106');
    assert.equal(loaderFromDependencies({ minecraft: '1.21.1', neoforge: '21.1.5' }).loadder_version, '21.1.5');
    assert.equal(loaderFromDependencies({ minecraft: '1.21.4' }).loadder_type, 'none');
    assert.throws(() => loaderFromDependencies({}), /Minecraft/);
});

test('dépendances exportées (préfixe Forge retiré)', () => {
    assert.deepEqual(instanceDependencies({ loadder: { minecraft_version: '1.20.1', loadder_type: 'forge', loadder_version: '1.20.1-47.2.0' } }),
        { minecraft: '1.20.1', forge: '47.2.0' });
    assert.deepEqual(instanceDependencies({ loadder: { minecraft_version: '1.21.4', loadder_type: 'none', loadder_version: 'latest' } }),
        { minecraft: '1.21.4' });
});

test('lecture : fichiers serveur ignorés, hôtes non vérifiés signalés, http refusé', async () => {
    let file = await makePack({ ...BASE, files: [
        { path: 'mods/a.jar', hashes: { sha1: 'x' }, downloads: ['https://cdn.modrinth.com/a.jar'], fileSize: 10 },
        { path: 'mods/b.jar', hashes: { sha1: 'y' }, downloads: ['https://exemple.org/b.jar'], fileSize: 5 },
        { path: 'mods/serveur.jar', hashes: { sha1: 'z' }, downloads: ['https://cdn.modrinth.com/s.jar'], env: { client: 'unsupported' } }
    ] }, { 'overrides/options.txt': 'fov:1' });
    let pack = await readModpack(file);
    assert.equal(pack.downloads.length, 2);
    assert.equal(pack.skipped, 1);
    assert.equal(pack.size, 15);
    assert.equal(pack.overrides, 1);
    assert.deepEqual(pack.foreignHosts, ['exemple.org']);

    let insecure = await makePack({ ...BASE, files: [{ path: 'mods/a.jar', hashes: { sha1: 'x' }, downloads: ['http://cdn.modrinth.com/a.jar'] }] });
    await assert.rejects(readModpack(insecure), /http/);
});

test('modpack CurseForge et archive sans index refusés avec un message clair', async () => {
    await assert.rejects(readModpack(await makePack(null, { 'manifest.json': '{}' })), /CurseForge/);
    await assert.rejects(readModpack(await makePack(null, { 'a.txt': '' })), /modrinth\.index\.json/);
});

test('installation : overrides puis client-overrides, chemins dangereux ignorés', async () => {
    let file = await makePack(BASE, {
        'overrides/config/a.txt': 'commun',
        'overrides/options.txt': 'fov:1',
        'client-overrides/options.txt': 'fov:2',
        'overrides/../evasion.txt': 'non'
    });
    let dir = path.join(tempDir(), 'instance');
    await installModpack(await readModpack(file), dir);
    assert.equal(fs.readFileSync(path.join(dir, 'config/a.txt'), 'utf8'), 'commun');
    assert.equal(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), 'fov:2');
    assert.equal(fs.existsSync(path.join(dir, '..', 'evasion.txt')), false);
});

test('arbre d\'export : données locales masquées, sélection par défaut', () => {
    let dir = tempDir();
    for (let d of ['mods', 'config', 'saves', 'logs', 'schematics']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'options.txt'), '');
    fs.writeFileSync(path.join(dir, 'servers.dat'), '');
    let tree = exportTree(dir);
    assert.deepEqual(tree.map(n => n.name), ['config', 'mods', 'schematics', 'options.txt']);
    assert.deepEqual(tree.filter(n => n.checked).map(n => n.name), ['config', 'mods']);
});

test('mise à jour du modpack : fichiers retirés supprimés, ajouts du joueur et options conservés', async () => {
    let dir = path.join(tempDir(), 'instance');
    let v1 = await makePack(BASE, {
        'overrides/mods/ancien.jar': 'v1',
        'overrides/mods/garde.jar': 'v1',
        'overrides/config/reglage.txt': 'v1',
        'overrides/options.txt': 'fov:1'
    });
    await installModpack(await readModpack(v1), dir);
    // Le joueur ajoute un mod, désactive un mod du pack et change ses options.
    fs.writeFileSync(path.join(dir, 'mods/perso.jar'), 'moi');
    fs.renameSync(path.join(dir, 'mods/ancien.jar'), path.join(dir, 'mods/ancien.jar.disabled'));
    fs.writeFileSync(path.join(dir, 'options.txt'), 'fov:9');

    let v2 = await makePack(BASE, {
        'overrides/mods/garde.jar': 'v2',
        'overrides/config/reglage.txt': 'v2',
        'overrides/options.txt': 'fov:1'
    });
    let { removed } = await updateModpack(await readModpack(v2), dir);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(path.join(dir, 'mods/ancien.jar.disabled')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'mods/garde.jar'), 'utf8'), 'v2');
    assert.equal(fs.readFileSync(path.join(dir, 'config/reglage.txt'), 'utf8'), 'v2');
    assert.equal(fs.readFileSync(path.join(dir, 'mods/perso.jar'), 'utf8'), 'moi');
    assert.equal(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), 'fov:9');
});
