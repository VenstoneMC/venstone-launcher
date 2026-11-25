/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, BrowserWindow, Menu } = require("electron");
const { secureWindow } = require("./security.js");
const path = require("path");
const os = require("os");
const pkg = require("../../../../package.json");
let dev = process.env.DEV_TOOL === 'open';
let mainWindow = undefined;

/** @returns {BrowserWindow|undefined} Fenêtre principale */
function getWindow() {
    return mainWindow;
}

/** Ferme l'application si la fenêtre principale existe. */
function destroyWindow() {
    if (!mainWindow) return;
    app.quit();
    mainWindow = undefined;
}

/** Crée la fenêtre principale (980×552, sans cadre). Les liens externes s'ouvrent dans le navigateur. */
function createWindow() {
    destroyWindow();
    mainWindow = new BrowserWindow({
        title: pkg.preductname,
        width: 980,
        height: 552,
        minWidth: 980,
        minHeight: 552,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        fullscreen: false,
        icon: `./src/assets/images/icon.${os.platform() === "win32" ? "ico" : "png"}`,
        frame: false,
        show: false,
        webPreferences: {
            // Code du launcher dans le preload, page sans accès à Node.js (voir preload.mjs).
            preload: path.join(app.getAppPath(), 'src/preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
    });
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    // Liens externes (carte, guide, discord, skins...) : navigateur par défaut.
    secureWindow(mainWindow);
    mainWindow.loadFile(path.join(`${app.getAppPath()}/src/launcher.html`));
    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            if (dev) mainWindow.webContents.openDevTools({ mode: 'detach' })
            mainWindow.show()
        }
    });
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};