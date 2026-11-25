/**
 * Environnement des tests : le code du launcher utilise `require` comme dans le preload
 * (résolution depuis src/, voir src/preload.mjs).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.require = createRequire(new URL('../src/preload.mjs', import.meta.url));

/** Dossier temporaire supprimé à la fin du processus de test. */
export function tempDir() {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venstone-test-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
