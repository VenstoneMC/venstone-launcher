/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 *
 * Ajout d'un compte : choix entre un compte Venstone (propre à Venstone, pseudo seulement) et un compte
 * Microsoft (Minecraft officiel, connexion dans le navigateur). Si l'API configure un serveur
 * AZauth, c'est lui qui est utilisé à la place.
 */
const { AZauth } = require('minecraft-java-core');
const { ipcRenderer } = require('electron');

import { popup, database, changePanel, accountSelect, addAccount, offlineAccount } from '../utils.js';
import { resolveInstanceSelection } from '../utils/instances.js';
import { isMicrosoft, sameAccount, microsoftError } from '../utils/accounts.js';

/** Pseudo Minecraft valide : 3 à 16 lettres, chiffres ou « _ ». */
const NAME_PATTERN = /^\w{3,16}$/;

class Login {
    static id = "login";

    /**
     * @param {object} config Configuration de l'API (`online` : false = comptes Venstone et
     *        Microsoft, true = Microsoft seulement, URL = AZauth ; `client_id` : application Azure)
     */
    async init(config) {
        this.config = config;
        this.db = new database();
        this.attempt = 0;
        this.q = selector => document.querySelector(`.login ${selector}`);

        if (typeof config.online == 'string' && /^https?:\/\/[^ "]+$/.test(config.online)) {
            this.getAZauth();
        } else {
            this.bindChoice();
            this.show();
        }
        // Depuis les paramètres (« Ajouter un compte ») : l'ajout peut être annulé.
        window.addEventListener('venstone:add-account', e => this.show({ cancelable: !!e.detail?.cancelable }));
    }

    /** Affiche un écran de connexion (les autres sont masqués). */
    tab(name) {
        document.querySelectorAll('.login .login-tabs').forEach(t => t.style.display = 'none');
        let tab = this.q(`.login-${name}`);
        tab.style.display = 'block';
        tab.querySelectorAll('.login-error').forEach(e => e.textContent = '');
        return tab;
    }

    /** Écran de départ : choix du type de compte. */
    show({ cancelable = false } = {}) {
        if (this.azauth) return this.tab('AZauth');
        this.cancelable = cancelable;
        this.q('.login-cancel').style.display = cancelable ? '' : 'none';
        this.q('.login-card[data-type="venstone"]').style.display = this.config.online === true ? 'none' : '';
        this.q('.login-card[data-type="microsoft"]').style.display = this.config.client_id ? '' : 'none';
        this.tab('choice');
    }

    bindChoice() {
        this.q('.login-cards').addEventListener('click', e => {
            let card = e.target.closest('.login-card');
            if (card?.dataset.type === 'venstone') {
                this.tab('offline');
                setTimeout(() => this.q('.email-offline').focus(), 50);
            } else if (card?.dataset.type === 'microsoft') {
                this.microsoftLogin();
            }
        });
        this.q('.login-cancel').addEventListener('click', () => changePanel('settings'));
        this.q('.login-back').addEventListener('click', () => this.show({ cancelable: this.cancelable }));

        this.q('.connect-offline').addEventListener('click', () => this.venstoneLogin());
        this.q('.email-offline').addEventListener('keydown', e => { if (e.key === 'Enter') this.venstoneLogin(); });

        this.q('.login-microsoft-retry').addEventListener('click', () => this.microsoftLogin());
        this.q('.login-microsoft-cancel').addEventListener('click', () => {
            this.attempt++;
            ipcRenderer.send('microsoft-cancel');
            this.show({ cancelable: this.cancelable });
        });
    }

    /** Message d'erreur sous le formulaire affiché. */
    error(tab, message) {
        this.q(`.login-${tab} .login-error`).textContent = message;
    }

    /* ------------------------------------------------------------------ */
    /* Compte Venstone                                                     */
    /* ------------------------------------------------------------------ */

    async venstoneLogin() {
        let name = this.q('.email-offline').value.trim();
        if (!NAME_PATTERN.test(name)) {
            return this.error('offline', name.length < 3 || name.length > 16
                ? 'Le pseudo doit faire entre 3 et 16 caractères.'
                : 'Le pseudo ne peut contenir que des lettres, des chiffres et « _ ».');
        }
        let account = offlineAccount(name);
        let accounts = await this.db.readAllData('accounts');
        if (accounts.some(a => sameAccount(a, account))) {
            return this.error('offline', 'Ce compte Venstone est déjà dans le launcher.');
        }
        await this.saveData(account);
        this.q('.email-offline').value = '';
    }

    /* ------------------------------------------------------------------ */
    /* Compte Microsoft                                                    */
    /* ------------------------------------------------------------------ */

    /** Ouvre la connexion dans le navigateur et attend le retour (annulable). */
    async microsoftLogin() {
        let attempt = ++this.attempt;
        this.tab('microsoft');
        let retry = this.q('.login-microsoft-retry');
        retry.textContent = 'Rouvrir la page';
        let result = await ipcRenderer.invoke('microsoft-login', this.config.client_id);
        if (attempt !== this.attempt) return; // annulée ou relancée entre-temps
        if (result.error) {
            let message = microsoftError(result);
            if (!message) return this.show({ cancelable: this.cancelable });
            retry.textContent = 'Réessayer';
            return this.error('microsoft', message);
        }
        // Compte déjà présent : ses jetons sont simplement remplacés.
        let accounts = await this.db.readAllData('accounts');
        let existing = accounts.find(a => isMicrosoft(a) && a.uuid === result.uuid);
        await this.saveData(result, existing?.ID);
    }

    /* ------------------------------------------------------------------ */
    /* AZauth (serveur d'authentification configuré par l'API)             */
    /* ------------------------------------------------------------------ */

    async getAZauth() {
        console.log('Initializing AZauth login...');
        this.azauth = true;
        let AZauthClient = new AZauth(this.config.online);
        let PopupLogin = new popup();
        let loginAZauth = document.querySelector('.login-AZauth');
        let loginAZauthA2F = document.querySelector('.login-AZauth-A2F');

        let AZauthEmail = document.querySelector('.email-AZauth');
        let AZauthPassword = document.querySelector('.password-AZauth');
        let AZauthA2F = document.querySelector('.A2F-AZauth');
        let connectAZauthA2F = document.querySelector('.connect-AZauth-A2F');
        let AZauthConnectBTN = document.querySelector('.connect-AZauth');
        let AZauthCancelA2F = document.querySelector('.cancel-AZauth-A2F');

        this.tab('AZauth');

        AZauthCancelA2F.addEventListener('click', () => {
            loginAZauthA2F.style.display = 'none';
            loginAZauth.style.display = 'block';
        });

        AZauthConnectBTN.addEventListener('click', async () => {
            if (AZauthEmail.value == '' || AZauthPassword.value == '') {
                PopupLogin.openPopup({ title: 'Erreur', content: 'Veuillez remplir tous les champs.', options: true });
                return;
            }
            PopupLogin.openPopup({ title: 'Connexion en cours...', content: 'Veuillez patienter...', color: 'var(--color)' });
            let AZauthConnect = await AZauthClient.login(AZauthEmail.value, AZauthPassword.value);

            if (AZauthConnect.error) {
                PopupLogin.openPopup({ title: 'Erreur', content: AZauthConnect.message, options: true });
            } else if (AZauthConnect.A2F) {
                loginAZauthA2F.style.display = 'block';
                loginAZauth.style.display = 'none';
                PopupLogin.closePopup();
            } else {
                await this.saveData(AZauthConnect);
                PopupLogin.closePopup();
            }
        });

        connectAZauthA2F.addEventListener('click', async () => {
            if (AZauthA2F.value == '') {
                PopupLogin.openPopup({ title: 'Erreur', content: 'Veuillez entrer le code A2F.', options: true });
                return;
            }
            PopupLogin.openPopup({ title: 'Connexion en cours...', content: 'Veuillez patienter...', color: 'var(--color)' });
            let AZauthConnect = await AZauthClient.login(AZauthEmail.value, AZauthPassword.value, AZauthA2F.value);
            if (AZauthConnect.error) {
                PopupLogin.openPopup({ title: 'Erreur', content: AZauthConnect.message, options: true });
                return;
            }
            await this.saveData(AZauthConnect);
            PopupLogin.closePopup();
        });
    }

    /* ------------------------------------------------------------------ */
    /* Enregistrement                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Enregistre le compte (ou met à jour `existingId`), le sélectionne et ouvre l'accueil.
     * @param {object} connectionData Compte renvoyé par la méthode de connexion
     * @param {number|string} [existingId] Compte déjà enregistré à remplacer
     */
    async saveData(connectionData, existingId = null) {
        let configClient = await this.db.readData('configClient');
        let account;
        if (existingId) {
            connectionData.ID = existingId;
            await this.db.updateData('accounts', connectionData, existingId);
            account = connectionData;
            document.getElementById(`${existingId}`)?.remove();
        } else {
            account = await this.db.createData('accounts', connectionData);
        }
        configClient.account_selected = account.ID;
        configClient.instance_selct = await resolveInstanceSelection(configClient, account);

        await this.db.updateData('configClient', configClient);
        await addAccount(account);
        await accountSelect(account);
        changePanel('home');
    }
}
export default Login;
