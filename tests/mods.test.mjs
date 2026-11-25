import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compare, _test } from '../src/assets/js/utils/mods.js';

test('versions numériques', () => {
    assert.deepEqual(parseVersion('1.21.8'), [1, 21, 8]);
    assert.deepEqual(parseVersion('v1.2-beta'), [1, 2]);
    assert.equal(parseVersion('25w14a'), null);
    assert.ok(compare([1, 21], [1, 20, 6]) > 0);
    assert.equal(compare([1, 21, 0], [1, 21]), 0);
});

test('prédicats de version Fabric', () => {
    assert.equal(_test.matchFabricPredicate('>=1.20', '1.21.1'), true);
    assert.equal(_test.matchFabricPredicate('<1.20', '1.21.1'), false);
    assert.equal(_test.matchFabricPredicate(['1.20.1', '1.21.1'], '1.21.1'), true);
    assert.equal(_test.matchFabricPredicate(undefined, '1.21.1'), true);
});

test('intervalles Maven (Forge / NeoForge)', () => {
    assert.equal(_test.matchMavenRange('[1.20,1.21)', '1.20.4'), true);
    assert.equal(_test.matchMavenRange('[1.20,1.21)', '1.21'), false);
    assert.equal(_test.matchMavenRange('[1.21,)', '1.21.4'), true);
});

test('listMods : lecture asynchrone, métadonnées en cache tant que le fichier ne change pas', async () => {
    let { tempDir } = await import('./setup.mjs');
    let { ZipWriter } = await import('../src/assets/js/utils/zip.js');
    let { listMods } = await import('../src/assets/js/utils/mods.js');
    let fs = await import('node:fs');
    let dir = tempDir();
    fs.mkdirSync(`${dir}/mods`);
    let jar = async (file, version) => {
        let zip = await ZipWriter.create(`${dir}/mods/${file}`);
        await zip.add('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Démo', version })));
        await zip.close();
    };
    await jar('demo.jar', '1.0.0');
    fs.writeFileSync(`${dir}/mods/notes.txt`, 'ignoré');

    let [first] = await listMods(dir);
    assert.equal(first.info.id, 'demo');
    assert.equal(first.info.version, '1.0.0');
    assert.equal((await listMods(dir))[0].info, first.info, 'même objet : lu depuis le cache');

    await new Promise(r => setTimeout(r, 20));
    await jar('demo.jar', '2.0.0');
    assert.equal((await listMods(dir))[0].info.version, '2.0.0', 'relu après modification');
});
