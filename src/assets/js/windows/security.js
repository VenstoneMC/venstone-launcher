/**
 * Protections communes aux fenêtres du launcher (pas à la fenêtre de connexion Microsoft,
 * qui doit pouvoir naviguer vers login.live.com).
 */

const { shell } = require("electron");

/** Liens web : ouverts dans le navigateur par défaut, uniquement en http(s). */
function openExternal(url) {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

/**
 * La page ne peut ni changer d'adresse, ni ouvrir de fenêtre, ni intégrer de <webview> :
 * un lien cliqué s'ouvre dans le navigateur.
 * @param {import('electron').BrowserWindow} window
 */
function secureWindow(window) {
    let contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        event.preventDefault();
        openExternal(url);
    });
    contents.on('will-attach-webview', event => event.preventDefault());
}

module.exports = { secureWindow };
