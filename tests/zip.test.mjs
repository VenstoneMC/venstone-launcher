import { tempDir } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { crc32, ZipWriter, listZip, readZipEntry } from '../src/assets/js/utils/zip.js';

test('crc32 : valeur de référence', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('ZipWriter puis lecture : fichiers compressés, stockés et noms accentués', async () => {
    let file = path.join(tempDir(), 'a.zip');
    let text = Buffer.from('bonjour '.repeat(200));
    let jar = Buffer.from('PK pas vraiment un jar');
    let zip = await ZipWriter.create(file);
    await zip.add('config/réglages.txt', text);
    await zip.add('mods/mod.jar', jar);
    await zip.close();

    let entries = await listZip(file);
    assert.deepEqual(entries.map(e => e.name), ['config/réglages.txt', 'mods/mod.jar']);
    assert.equal(entries[0].method, 8, 'texte compressé');
    assert.equal(entries[1].method, 0, '.jar stocké tel quel');
    assert.deepEqual(await readZipEntry(file, entries[0]), text);
    assert.deepEqual(await readZipEntry(file, entries[1]), jar);
});

test('listZip refuse un fichier qui n\'est pas une archive', async () => {
    let file = path.join(tempDir(), 'faux.zip');
    (await import('node:fs')).writeFileSync(file, 'rien à voir');
    await assert.rejects(listZip(file), /archive valide/);
});
