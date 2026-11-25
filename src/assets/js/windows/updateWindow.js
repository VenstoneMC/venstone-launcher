/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

"use strict";
const { app, BrowserWindow, Menu } = require("electron");
const { secureWindow } = require("./security.js");
const path = require("path");
const os = require("os");
let dev = process.env.DEV_TOOL === 'open';
let updateWindow = undefined;

/** @returns {BrowserWindow|undefined} Fenêtre de mise à jour */
function getWindow() {
    return updateWindow;
}

/** Ferme la fenêtre de mise à jour. */
function destroyWindow() {
    if (!updateWindow) return;
    updateWindow.close();
    updateWindow = undefined;
}

/** Crée la fenêtre de mise à jour (splash). */
function createWindow() {
    destroyWindow();
    updateWindow = new BrowserWindow({
        title: "Mise à jour",
        width: 400,
        height: 500,
        resizable: false,
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
    updateWindow.setMenuBarVisibility(false);
    secureWindow(updateWindow);
    updateWindow.loadFile(path.join(`${app.getAppPath()}/src/index.html`));
    updateWindow.once('ready-to-show', () => {
        if (updateWindow) {
            if (dev) updateWindow.webContents.openDevTools({ mode: 'detach' })
            updateWindow.show();
        }
    });
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};