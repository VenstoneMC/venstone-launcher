/**
 * Point d'entrée du code des fenêtres (launcher et mise à jour).
 *
 * Les pages n'ont pas accès à Node.js (contextIsolation, pas de nodeIntegration) : tout le code
 * du launcher s'exécute ici, dans le monde isolé du preload, qui partage le DOM avec la page
 * mais pas ses variables. Un HTML injecté par erreur (description Modrinth, actualité...) ne
 * peut donc plus lire ou écrire de fichiers, ni lancer de programme.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

// Le code du launcher utilise `require` et `__dirname` comme un renderer Node classique :
// mêmes valeurs qu'avant (résolution depuis le dossier des pages).
globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = root;

/** Script de chaque page. */
const ENTRIES = {
    'launcher.html': 'assets/js/launcher.js',
    'index.html': 'assets/js/index.js'
};

let entry = ENTRIES[path.basename(fileURLToPath(location.href))];
if (entry) {
    // Comme un <script type="module"> : exécuté une fois le HTML analysé. Pas d'await ici :
    // Electron attend la fin du preload avant de charger la page.
    let start = () => import(pathToFileURL(path.join(root, entry)).href).catch(err => console.error('[Preload]', err));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}
