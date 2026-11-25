import { tempDir } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeCrash, findCrashReport, GameOutput } from '../src/assets/js/utils/crash.js';

test('causes fréquentes reconnues', () => {
    assert.equal(analyzeCrash({ output: 'Exception: java.lang.OutOfMemoryError: Java heap space' }).title, 'Mémoire insuffisante');
    assert.equal(analyzeCrash({ output: 'Error: Could not reserve enough space for object heap' }).title, 'Mémoire allouée invalide');
    let jvm = analyzeCrash({ output: "Unrecognized VM option 'VenstoneTest'\nError: Could not create the Java Virtual Machine." });
    assert.equal(jvm.title, "Java n'a pas pu démarrer");
    assert.deepEqual(jvm.details, ['Option refusée : VenstoneTest']);
    assert.equal(analyzeCrash({ output: 'has been compiled by a more recent version of the Java Runtime (class file version 65.0)' }).title, 'Mauvaise version de Java');

    let fabric = analyzeCrash({ output: [
        '[main/ERROR]: Incompatible mods found!',
        '[main/ERROR]:  - Mod \'Sodium Extra\' (sodium-extra) 0.9 requires version 0.6 of sodium',
        '[main/ERROR]:  - Remove mod \'Sodium Extra\'',
        'other line'
    ].join('\n') });
    assert.equal(fabric.title, 'Mods incompatibles');
    assert.equal(fabric.details.length, 2);
    assert.match(fabric.details[0], /^Mod 'Sodium Extra'/);

    assert.deepEqual(analyzeCrash({ output: 'Mixin apply for mod coolmod failed coolmod.mixins.json' }).details, ['Mod en cause : coolmod']);
});

test('rapport sans cause connue : description du rapport, sinon rien', () => {
    let crash = analyzeCrash({ output: '', report: '---- Minecraft Crash Report ----\nDescription: Rendering overlay\n' });
    assert.equal(crash.details[0], 'Description : Rendering overlay');
    assert.equal(analyzeCrash({ output: '[Render thread/INFO]: Stopping!' }), null);
});

test('rapport de plantage écrit pendant la session', () => {
    let dir = tempDir();
    fs.mkdirSync(path.join(dir, 'crash-reports'));
    let since = Date.now() - 1000;
    assert.equal(findCrashReport(dir, since), null);
    fs.writeFileSync(path.join(dir, 'crash-reports', 'crash-1.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'hs_err_pid42.log'), 'y');
    assert.ok(findCrashReport(dir, since));
    assert.equal(findCrashReport(dir, Date.now() + 60_000), null, 'rapports antérieurs ignorés');
});

test('sortie du jeu limitée à la fin', () => {
    let output = new GameOutput();
    for (let i = 0; i < 2000; i++) output.push('x'.repeat(1000));
    assert.ok(output.text.length <= 600 * 1024);
});
