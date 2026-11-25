import { tempDir } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setResourcePacks, activeResourcePacks, shaderLoader, setActiveShaderPack, activeShaderPack } from '../src/assets/js/utils/packs.js';

test('packs de textures : ordre conservé, packs intégrés laissés en place', () => {
    let dir = tempDir();
    fs.writeFileSync(path.join(dir, 'options.txt'), 'fov:0.5\nresourcePacks:["vanilla","fabric","file/Ancien.zip"]\n');
    // Ordre affiché : du plus prioritaire au moins prioritaire.
    setResourcePacks(dir, '1.21.1', ['B.zip', 'A.zip'], ['A.zip']);
    let options = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8');
    assert.match(options, /^resourcePacks:\["vanilla","fabric","file\/A\.zip","file\/B\.zip"\]$/m);
    assert.match(options, /^incompatibleResourcePacks:\["file\/A\.zip"\]$/m);
    assert.match(options, /^fov:0\.5$/m);
    assert.deepEqual(activeResourcePacks(dir, '1.21.1'), ['A.zip', 'B.zip']);
});

test('shaders : mod détecté et pack actif lu / écrit (Iris)', () => {
    let mods = [{ enabled: true, info: { id: 'sodium' } }, { enabled: true, info: { id: 'iris' } }];
    assert.deepEqual(shaderLoader(mods), { id: 'iris', name: 'Iris' });
    assert.equal(shaderLoader([{ enabled: false, info: { id: 'iris' } }]), null);

    let dir = tempDir();
    let iris = { id: 'iris' };
    setActiveShaderPack(dir, iris, 'Complémentaire é.zip');
    assert.equal(activeShaderPack(dir, iris), 'Complémentaire é.zip');
    setActiveShaderPack(dir, iris, null);
    assert.equal(activeShaderPack(dir, iris), null);
});
