import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentLoaders, bestVersion, primaryFile, compactNumber } from '../src/assets/js/utils/modrinth.js';

const instance = (type, mc = '1.21.1') => ({ loadder: { loadder_type: type, minecraft_version: mc } });

test('loaders demandés à Modrinth selon l\'instance', () => {
    assert.deepEqual(contentLoaders('mods', instance('fabric')), ['fabric']);
    assert.deepEqual(contentLoaders('mods', instance('quilt')), ['quilt', 'fabric']);
    assert.deepEqual(contentLoaders('mods', instance('neoforge', '1.20.1')), ['neoforge', 'forge']);
    assert.deepEqual(contentLoaders('mods', instance('none')), []);
    assert.deepEqual(contentLoaders('resourcepacks', instance('fabric')), ['minecraft']);
    assert.deepEqual(contentLoaders('shaderpacks', instance('fabric'), { id: 'iris' }), ['iris']);
    assert.deepEqual(contentLoaders('shaderpacks', instance('forge'), { id: 'optifine' }), ['optifine']);
    assert.deepEqual(contentLoaders('shaderpacks', instance('fabric'), null), ['iris', 'optifine']);
});

test('meilleure version : la stable la plus récente, sinon la plus récente', () => {
    let v = (id, type, date) => ({ id, version_type: type, date_published: date });
    assert.equal(bestVersion([v('a', 'release', '2025-01-01'), v('b', 'beta', '2025-03-01'), v('c', 'release', '2025-02-01')]).id, 'c');
    assert.equal(bestVersion([v('a', 'alpha', '2025-01-01'), v('b', 'beta', '2025-03-01')]).id, 'b');
    assert.equal(bestVersion([]), null);
});

test('fichier principal d\'une version', () => {
    assert.equal(primaryFile({ files: [{ filename: 'a' }, { filename: 'b', primary: true }] }).filename, 'b');
    assert.equal(primaryFile({ files: [{ filename: 'a' }] }).filename, 'a');
});

test('nombres compacts', () => {
    assert.equal(compactNumber(950), '950');
    assert.equal(compactNumber(1234), '1,2 k');
    assert.equal(compactNumber(56_000), '56 k');
    assert.equal(compactNumber(2_500_000), '2,5 M');
});
