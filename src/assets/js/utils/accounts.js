/**
 * Comptes du launcher :
 *  - Compte Venstone : propre à Venstone, hors-ligne (pseudo uniquement, `meta.type` « Mojang ») ;
 *  - Compte Microsoft : compte Minecraft officiel (`meta.type` « Xbox »), connexion et jetons
 *    gérés par le processus principal (src/main/microsoft.js).
 * Deux comptes peuvent porter le même pseudo seulement s'ils sont de types différents.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const nodeFetch = require('node-fetch');
const { ipcRenderer } = require('electron');

export const DEFAULT_HEAD = 'assets/images/default/steve.png';

/** @returns {boolean} Compte Microsoft (Minecraft officiel) */
export function isMicrosoft(account) {
    return account?.meta?.type === 'Xbox';
}

/** Libellé du type de compte. */
export function accountLabel(account) {
    return isMicrosoft(account) ? 'Compte Microsoft' : 'Compte Venstone';
}

/** Même compte : même type et même pseudo (sans tenir compte des majuscules). */
export function sameAccount(a, b) {
    return isMicrosoft(a) === isMicrosoft(b) && String(a?.name).toLowerCase() === String(b?.name).toLowerCase();
}

/** Page de changement de skin du compte. */
export function skinPage(account) {
    return isMicrosoft(account)
        ? 'https://www.minecraft.net/fr-fr/msaprofile/mygames/editskin'
        : 'https://venstone.xyz/skin/';
}

/** Tête du joueur en ligne (256 px pour Microsoft). */
function remoteHead(account) {
    let name = encodeURIComponent(account.name);
    return isMicrosoft(account)
        ? `https://mc-heads.net/avatar/${name}/256`
        : `https://venstone.xyz/api/skin/${name}/head.png`;
}

let headDir = null;
/**
 * Rafraîchissement de chaque tête pendant cette session (une requête par compte au plus) :
 * promesse de la nouvelle URL, ou null si l'image en cache est déjà à jour. Partagée par tous
 * les affichages de la même tête (carte des paramètres et accueil, affichés en même temps).
 */
let refreshes = new Map();

/** Fichier de cache de la tête d'un compte (le launcher peut démarrer hors-ligne). */
async function headFile(account) {
    headDir ??= path.join(await ipcRenderer.invoke('path-user-data'), 'heads');
    let name = String(account.name).replace(/[^\w-]/g, '_');
    return path.join(headDir, `${isMicrosoft(account) ? 'microsoft' : 'venstone'}-${name}.png`);
}

/**
 * Affiche la tête d'un compte : l'image en cache tout de suite, puis la version à jour
 * (une fois par session) si le launcher est en ligne. Steve si aucune n'est disponible.
 * @param {object} account
 * @param {(url: string) => void} apply Reçoit une URL utilisable en CSS
 * @param {{offline?: boolean}} [options]
 */
export async function loadHead(account, apply, { offline = false } = {}) {
    let file = await headFile(account);
    let cached = fs.existsSync(file);
    apply(cached ? `${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}` : DEFAULT_HEAD);

    if (offline) return;
    let key = file.toLowerCase();
    if (!refreshes.has(key)) refreshes.set(key, refreshHead(account, file, key));
    let url = await refreshes.get(key);
    if (url) apply(url);
}

/**
 * Télécharge la tête à jour et la met en cache.
 * @returns {Promise<string|null>} URL de l'image en cache, ou null si rien n'a changé / échec
 */
async function refreshHead(account, file, key) {
    try {
        let res = await nodeFetch(remoteHead(account), { timeout: 8000, headers: { 'User-Agent': 'Venstone-Launcher' } });
        if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
        let data = await res.buffer();
        if (fs.existsSync(file) && fs.readFileSync(file).equals(data)) return null;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
        return `${pathToFileURL(file).href}?v=${Date.now()}`;
    } catch {
        refreshes.delete(key); // nouvel essai au prochain affichage
        return null;
    }
}

/**
 * Message lisible d'une erreur de connexion Microsoft (null pour une annulation).
 * @param {{error: string, message?: string}} result
 * @returns {string|null}
 */
export function microsoftError({ error, message }) {
    switch (error) {
        case 'cancel': return null;
        case 'config': return "La connexion Microsoft n'est pas encore disponible pour Venstone. Utilisez un compte Venstone en attendant.";
        case 'unreachable': return 'Les serveurs de connexion Microsoft ne répondent pas. Réessayez dans quelques minutes.';
        case 'denied': return 'La connexion a été annulée dans le navigateur.';
        case 'timeout': return 'La connexion a pris trop de temps. Réessayez.';
        case 'expired': return 'La session de ce compte Microsoft a expiré. Reconnectez-le depuis les paramètres.';
        case 'noGame': return 'Ce compte Microsoft ne possède pas Minecraft Java Edition.';
        case 'noXbox': return "Ce compte Microsoft n'a pas encore de profil Xbox. Créez-le sur xbox.com, puis réessayez.";
        case 'child': return 'Ce compte appartient à un mineur : un adulte doit l\'ajouter à une famille Microsoft.';
        case 'adult': return 'Ce compte doit être vérifié comme majeur sur xbox.com avant de pouvoir jouer.';
        case 'region': return "Xbox Live n'est pas disponible dans le pays de ce compte.";
        default: return `Connexion Microsoft impossible : ${message || error}`;
    }
}
