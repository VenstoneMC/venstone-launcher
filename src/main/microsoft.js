/**
 * Connexion Microsoft (compte Minecraft officiel), exécutée dans le processus principal.
 *
 *  - Connexion dans le navigateur par défaut : OAuth 2 « code d'autorisation » + PKCE, avec
 *    retour sur un petit serveur local (http://localhost:<port>). L'application Azure de
 *    `client_id` doit avoir la plateforme « Applications mobiles et de bureau » avec
 *    l'URI de redirection `http://localhost`, et l'accès à l'API Minecraft.
 *  - Les jetons ne quittent jamais ce processus en clair vers le disque : le compte enregistré
 *    par la page contient un bloc `secure` chiffré avec safeStorage (DPAPI sous Windows,
 *    Trousseau sous macOS, libsecret sous Linux).
 *  - Chaîne Xbox Live → XSTS → Minecraft : `Microsoft#getAccount` de minecraft-java-core.
 */

const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage } = require('electron');
const { Microsoft } = require('minecraft-java-core');

const AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';
const LOGIN_TIMEOUT = 5 * 60 * 1000;
/** Marge avant expiration du jeton Minecraft (24 h de validité) pour le renouveler. */
const REFRESH_MARGIN = 10 * 60;

/** Erreur avec un code lisible par la page (voir `describe`). */
class AuthError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

/* ------------------------------------------------------------------ */
/* Chiffrement des jetons                                              */
/* ------------------------------------------------------------------ */

function seal(secret) {
    let json = JSON.stringify(secret);
    if (safeStorage.isEncryptionAvailable()) return { v: 1, data: safeStorage.encryptString(json).toString('base64') };
    // Pas de trousseau (certains Linux) : stockage en clair, comme avant.
    return { v: 0, data: Buffer.from(json).toString('base64') };
}

function unseal(secure) {
    if (!secure?.data) throw new AuthError('expired');
    let buf = Buffer.from(secure.data, 'base64');
    try {
        return JSON.parse(secure.v === 1 ? safeStorage.decryptString(buf) : buf.toString());
    } catch {
        // Données chiffrées sur un autre PC ou par un autre utilisateur Windows.
        throw new AuthError('expired');
    }
}

/* ------------------------------------------------------------------ */
/* OAuth                                                               */
/* ------------------------------------------------------------------ */

const base64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Page affichée dans le navigateur à la fin de la connexion. */
function page(title, text) {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
        <style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1b;color:#e1e1e1;font-family:system-ui,sans-serif}
        div{max-width:420px;padding:32px;border-radius:14px;background:#292929;border:1px solid #414141;text-align:center}
        h1{margin:0 0 10px;font-size:20px}p{margin:0;color:#a9a9a9;line-height:1.5}</style></head>
        <body><div><h1>${title}</h1><p>${text}</p></div></body></html>`;
}

/**
 * Appel du point de jeton Microsoft.
 * @param {object} params Paramètres du formulaire
 */
async function tokenRequest(params) {
    let res;
    try {
        res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(15000)
        });
    } catch {
        throw new AuthError('unreachable');
    }
    if (res.status >= 500) throw new AuthError('unreachable');
    let data = await res.json().catch(() => ({}));
    if (data.error === 'invalid_grant') throw new AuthError('expired');
    if (data.error) throw new AuthError('oauth', data.error_description || data.error);
    return data;
}

/**
 * minecraft-java-core ne vérifie pas le statut des réponses : un refus de
 * login_with_xbox (application Azure pas encore validée par Mojang, réponse 403
 * « Invalid app registration ») passait inaperçu et finissait en « jeu non possédé ».
 */
class MinecraftAuth extends Microsoft {
    async fetchJSON(url, options) {
        let data = await super.fetchJSON(url, options);
        if (url.endsWith('/authentication/login_with_xbox') && data && !data.access_token && !data.error) {
            data.error = data.errorMessage || 'login_with_xbox';
        }
        return data;
    }
}

/** Codes XErr de Xbox Live (comptes sans profil Xbox, mineurs...). */
const XERR = {
    2148916233: 'noXbox',
    2148916235: 'region',
    2148916236: 'adult',
    2148916237: 'adult',
    2148916238: 'child'
};

/**
 * Compte Minecraft à partir des jetons Microsoft, prêt à être enregistré par la page.
 * @param {string} clientId
 * @param {{access_token: string, refresh_token: string}} oauth2
 */
async function account(clientId, oauth2) {
    let acc;
    try {
        acc = await new MinecraftAuth(clientId).getAccount(oauth2);
    } catch {
        throw new AuthError('unreachable'); // réponse illisible (service en panne)
    }
    if (acc?.error) {
        if (acc.XErr && XERR[acc.XErr]) throw new AuthError(XERR[acc.XErr]);
        if (acc.errorType === 'mcLogin' && /Invalid app registration|AppRegInfo/i.test(String(acc.errorMessage || acc.error))) {
            throw new AuthError('config');
        }
        if (acc.errorType === 'game') throw new AuthError('noGame');
        if (/fetch|network|ENOTFOUND|ECONN|timeout/i.test(String(acc.error))) throw new AuthError('unreachable');
        throw new AuthError('service', String(acc.errorMessage || acc.error));
    }
    return {
        name: acc.name,
        uuid: acc.uuid,
        client_token: acc.client_token,
        user_properties: '{}',
        meta: { type: 'Xbox', access_token_expires_in: acc.meta.access_token_expires_in },
        xboxAccount: acc.xboxAccount,
        secure: seal({ access_token: acc.access_token, refresh_token: acc.refresh_token || oauth2.refresh_token })
    };
}

/** Réponses de Microsoft quand l'application Azure de `client_id` est mal configurée. */
const CONFIG_ERROR = /redirect_uri(?:'|&#39;)? is not valid|AADSTS50011|AADSTS700016|unauthorized_client|invalid_client/i;

/**
 * Vérifie que Microsoft accepte l'adresse de connexion avant d'ouvrir le navigateur : avec une
 * application Azure mal configurée, le navigateur n'afficherait qu'une page d'erreur et la page
 * d'attente resterait bloquée. Sans réponse (réseau), la connexion continue normalement.
 * @param {string} url Adresse d'autorisation complète
 */
async function checkAuthorizeUrl(url) {
    let body;
    try {
        let res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
        body = await res.text();
    } catch {
        return;
    }
    if (CONFIG_ERROR.test(body)) throw new AuthError('config');
}

let pending = null;

/**
 * Ouvre la connexion Microsoft dans le navigateur et attend le retour.
 * @param {string} clientId
 * @returns {Promise<object>} Compte à enregistrer
 */
async function login(clientId) {
    cancel();
    let verifier = base64url(crypto.randomBytes(32));
    let challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    let state = base64url(crypto.randomBytes(16));
    let server = http.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
    let redirect = `http://localhost:${server.address().port}`;
    let params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirect,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account'
    });
    let authorizeUrl = `${AUTHORIZE_URL}?${params}`;
    let attempt = {};
    pending = { cancel: () => { attempt.cancelled = true; attempt.reject?.(new AuthError('cancel')); } };

    try {
        await checkAuthorizeUrl(authorizeUrl);
        if (attempt.cancelled) throw new AuthError('cancel');
        let code = await new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new AuthError('timeout')), LOGIN_TIMEOUT);
            attempt.reject = reject;
            server.on('request', (req, res) => {
                let url = new URL(req.url, redirect);
                if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                if (url.searchParams.get('code')) {
                    res.end(page('Connexion réussie', 'Vous pouvez fermer cette page et revenir sur le launcher Venstone.'));
                    resolve(url.searchParams.get('code'));
                } else {
                    res.end(page('Connexion annulée', 'Revenez sur le launcher Venstone pour réessayer.'));
                    reject(new AuthError('denied'));
                }
                clearTimeout(timer);
            });
            shell.openExternal(authorizeUrl);
        });
        let oauth2 = await tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, scope: SCOPE });
        return await account(clientId, oauth2);
    } finally {
        pending = null;
        server.close();
    }
}

/** Annule la connexion en cours (bouton Annuler de la page d'attente). */
function cancel() {
    pending?.cancel();
    pending = null;
}

/**
 * Identifiants de lancement d'un compte enregistré, renouvelés si besoin.
 * @param {string} clientId
 * @param {object} saved Compte enregistré (avec `secure`)
 * @param {{offline?: boolean}} [options] Hors-ligne : jeton actuel même expiré (le solo l'accepte)
 * @returns {Promise<{auth: object, account: object|null}>} `account` : compte mis à jour à enregistrer
 */
async function session(clientId, saved, { offline = false } = {}) {
    let secret = unseal(saved.secure);
    let now = Math.floor(Date.now() / 1000);
    let updated = null;
    if (!offline && !(saved.meta?.access_token_expires_in - REFRESH_MARGIN > now)) {
        let oauth2 = await tokenRequest({ client_id: clientId, grant_type: 'refresh_token', refresh_token: secret.refresh_token, scope: SCOPE });
        updated = await account(clientId, oauth2);
        secret = unseal(updated.secure);
    }
    let source = updated || saved;
    return {
        auth: {
            access_token: secret.access_token,
            client_token: source.client_token,
            uuid: source.uuid,
            name: source.name,
            user_properties: '{}',
            meta: { type: 'Xbox', online: true }
        },
        account: updated
    };
}

/**
 * Enveloppe pour ipcMain.handle : les erreurs sont renvoyées comme `{ error: code }`
 * (une exception IPC perdrait son code).
 */
function handler(fn) {
    return async (_event, ...args) => {
        try {
            return await fn(...args);
        } catch (err) {
            if (!(err instanceof AuthError)) console.error('[Microsoft]', err);
            return { error: err.code || 'service', message: err.message };
        }
    };
}

module.exports = { login, cancel, session, handler };
