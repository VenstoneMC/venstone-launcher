/**
 * Navigation Modrinth dans le launcher.
 *
 *  - Contenu d'une instance (mods, packs de textures, shaders) : seuls les projets compatibles
 *    avec la version et le loader de l'instance sont proposés. L'installation ajoute les
 *    dépendances requises, signale les conflits, puis passe par l'import habituel de l'éditeur
 *    (mêmes vérifications que pour un fichier ajouté à la main).
 *  - Modpacks : le .mrpack choisi est téléchargé puis importé dans une nouvelle instance.
 */

import { escapeHTML, initials, loaderLabel } from '../utils/instanceForm.js'
import { confirmDialog, reasonsList } from '../utils/dialog.js'
import { getMinecraftVersions } from '../utils/instances.js'
import {
    search, projectVersions, identify, resolveDependencies, downloadVersion, tempFolder, bestVersion,
    contentLoaders, compactNumber, relativeDate, FABRIC_API_ID
} from '../utils/modrinth.js'

const { shell } = require('electron')
const fs = require('fs')

const PAGE_SIZE = 20

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24"><path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16 6.3 10.3l1.4-1.4 3.3 3.3zM4 18h16v2H4z"/></svg>'
const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21 10.6 19.7C5.4 15 2 11.9 2 8.2 2 5.1 4.4 3 7.3 3c1.7 0 3.4.8 4.7 2.1C13.3 3.8 15 3 16.7 3 19.6 3 22 5.1 22 8.2c0 3.7-3.4 6.8-8.6 11.5z"/></svg>'
const ICON_CLOCK = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm1 5h-2v6l5 3 1-1.7-4-2.3z"/></svg>'
const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>'
const ICON_EXTERNAL = '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H6v11h11v-5h2v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>'

/** Textes propres à chaque type de contenu. */
const KIND_TEXT = {
    mods: { title: 'Mods', one: 'mod', search: 'Rechercher un mod...' },
    resourcepacks: { title: 'Packs de textures', one: 'pack de textures', search: 'Rechercher un pack de textures...' },
    shaderpacks: { title: 'Shaders', one: 'pack de shaders', search: 'Rechercher un shader...' },
    modpacks: { title: 'Modpacks', one: 'modpack', search: 'Rechercher un modpack...' }
}

export default class ModrinthBrowser {
    /** @param {object} home Panneau d'accueil */
    constructor(home) {
        this.home = home
        this.root = document.querySelector('.browse-popup')
        this.editor = null
        this.kind = 'mods'
        this.hits = []
        this.total = 0
        this.seq = 0
        this.loading = false
        this.error = null
        this.selected = null
        this.installed = new Map()
        this.busy = new Set()
        this.bind()
    }

    q(selector) {
        return this.root.querySelector(selector)
    }

    /** Mode modpacks (depuis le sélecteur d'instance) ou contenu d'une instance. */
    get modpacks() {
        return this.kind === 'modpacks'
    }

    get instance() {
        return this.editor?.instance
    }

    /** Loaders Modrinth et version du jeu demandés pour l'onglet courant. */
    get filter() {
        if (this.modpacks) {
            let loader = this.q('.browse-loader').value
            return { loaders: loader ? [loader] : [], gameVersion: this.q('.browse-version').value || null }
        }
        return {
            loaders: contentLoaders(this.kind, this.instance, this.editor.shaderLoader),
            gameVersion: this.instance.loadder.minecraft_version
        }
    }

    bind() {
        this.q('.browse-close').addEventListener('click', () => this.close())
        this.q('.browse-back').addEventListener('click', () => {
            this.close()
            if (this.modpacks) this.home.openInstancePicker()
        })
        this.root.addEventListener('mousedown', e => { if (e.target === this.root) this.close() })

        this.q('.browse-kinds').addEventListener('click', e => {
            let tab = e.target.closest('.edit-tab-btn')
            if (tab && tab.dataset.kind !== this.kind) this.switchKind(tab.dataset.kind)
        })

        let timer = null
        this.q('.browse-search').addEventListener('input', () => {
            clearTimeout(timer)
            timer = setTimeout(() => this.search(), 350)
        })
        ;['.browse-sort', '.browse-version', '.browse-loader'].forEach(s => this.q(s).addEventListener('change', () => this.search()))

        let results = this.q('.browse-results')
        results.addEventListener('scroll', () => {
            if (results.scrollTop + results.clientHeight > results.scrollHeight - 200) this.loadMore()
        })
        results.addEventListener('click', e => {
            if (e.target.closest('.browse-retry')) return this.search()
            let card = e.target.closest('.browse-card')
            if (!card) return
            let hit = this.hits.find(h => h.project_id === card.dataset.id)
            if (!hit) return
            if (e.target.closest('.browse-quick')) return this.install(hit)
            this.select(hit)
        })

        let detail = this.q('.browse-detail')
        detail.addEventListener('change', e => {
            if (e.target.closest('.browse-detail-version')) this.renderDependencies()
        })
        detail.addEventListener('click', e => {
            if (e.target.closest('.browse-detail-install') && this.selected) {
                let version = this.detailVersions?.find(v => v.id === this.q('.browse-detail-version')?.value)
                this.install(this.selected, version)
            }
            if (e.target.closest('.browse-detail-link') && this.selected) {
                let type = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', modpacks: 'modpack' }[this.kind]
                shell.openExternal(`https://modrinth.com/${type}/${this.selected.slug}`)
            }
        })
    }

    /**
     * Ouvre la navigation.
     * @param {"mods"|"resourcepacks"|"shaderpacks"|"modpacks"} kind
     * @param {object|null} [editor] Éditeur de l'instance (contenu) ; null pour les modpacks
     */
    async open(kind, editor = null) {
        this.editor = editor
        this.q('.browse-search').value = ''
        this.q('.browse-sort').value = 'relevance'
        this.q('.browse-version').classList.toggle('hidden', kind !== 'modpacks')
        this.q('.browse-loader').classList.toggle('hidden', kind !== 'modpacks')
        this.q('.browse-kinds').classList.toggle('hidden', kind === 'modpacks')
        if (editor) {
            this.q('.browse-kinds [data-kind="mods"]').classList.toggle('hidden', !editor.modded)
            this.q('.browse-kinds [data-kind="shaderpacks"]').classList.toggle('hidden', !editor.modded)
        }
        if (kind === 'modpacks') this.fillVersionFilter()
        this.home.openPopup('.browse-popup')
        this.switchKind(kind)
    }

    close() {
        this.seq++
        this.home.closePopup('.browse-popup')
    }

    /** Change d'onglet (mods, packs, shaders) et relance la recherche. */
    switchKind(kind) {
        this.kind = kind
        this.selected = null
        this.q('.browse-search').value = ''
        this.root.querySelectorAll('.browse-kinds .edit-tab-btn').forEach(t => t.classList.toggle('active', t.dataset.kind === kind))
        this.q('.browse-search').placeholder = KIND_TEXT[kind].search
        this.renderSubtitle()
        this.renderDetail()
        this.installed = new Map()
        this.search()
        if (!this.modpacks) this.refreshInstalled()
    }

    /** Ligne sous le titre : compatibilité recherchée. */
    renderSubtitle() {
        let title = this.q('.browse-title')
        let subtitle = this.q('.browse-subtitle')
        if (this.modpacks) {
            title.textContent = 'Modpacks Modrinth'
            subtitle.textContent = 'Choisissez un modpack, il sera installé dans une nouvelle instance personnelle.'
            return
        }
        title.textContent = `${KIND_TEXT[this.kind].title} · ${this.instance.name}`
        let mc = escapeHTML(this.instance.loadder.minecraft_version)
        if (this.kind === 'mods') subtitle.innerHTML = `Compatibles avec <b>${escapeHTML(loaderLabel(this.instance))}</b> pour Minecraft <b>${mc}</b>`
        else if (this.kind === 'resourcepacks') subtitle.innerHTML = `Compatibles avec Minecraft <b>${mc}</b>`
        else {
            let loader = this.editor.shaderLoader
            subtitle.innerHTML = loader
                ? `Compatibles avec <b>${escapeHTML(loader.name)}</b> pour Minecraft <b>${mc}</b>`
                : `<span class="orange">Aucun mod de shaders installé</span> : installez Iris depuis l'onglet Mods pour les utiliser.`
        }
    }

    /** Versions de Minecraft proposées dans le filtre des modpacks (versions stables). */
    async fillVersionFilter() {
        let select = this.q('.browse-version')
        if (select.options.length > 1) return
        select.innerHTML = '<option value="">Toutes les versions</option>'
        try {
            let { versions } = await getMinecraftVersions()
            select.insertAdjacentHTML('beforeend', versions.filter(v => v.type === 'release')
                .map(v => `<option value="${escapeHTML(v.id)}">${escapeHTML(v.id)}</option>`).join(''))
        } catch { /* filtre limité à « Toutes les versions » */ }
    }

    /* ------------------------------------------------------------------ */
    /* Recherche                                                           */
    /* ------------------------------------------------------------------ */

    /** Nouvelle recherche (première page). */
    async search() {
        let seq = ++this.seq
        this.hits = []
        this.total = 0
        this.error = null
        this.q('.browse-results').scrollTop = 0
        await this.fetchPage(seq)
    }

    /** Page suivante, au défilement. */
    loadMore() {
        if (this.loading || this.error || this.hits.length >= this.total) return
        this.fetchPage(this.seq)
    }

    async fetchPage(seq) {
        this.loading = true
        this.renderResults()
        try {
            let { loaders, gameVersion } = this.filter
            let page = await search({
                kind: this.kind,
                query: this.q('.browse-search').value.trim(),
                sort: this.q('.browse-sort').value,
                loaders,
                gameVersion,
                offset: this.hits.length,
                limit: PAGE_SIZE
            })
            if (seq !== this.seq) return
            let known = new Set(this.hits.map(h => h.project_id))
            this.hits.push(...page.hits.filter(h => !known.has(h.project_id)))
            this.total = page.total_hits
        } catch (err) {
            if (seq !== this.seq) return
            console.error('[Modrinth]', err)
            this.error = err.message
        }
        this.loading = false
        this.renderResults()
    }

    /** Projets installés dans l'onglet courant (identifiés par Modrinth à partir des fichiers). */
    async refreshInstalled() {
        let kind = this.kind
        let items = this.editor.itemsOf(kind).filter(i => !i.folder)
        let installed = new Map()
        try {
            let found = await identify(items.map(i => i.path))
            for (let item of items) {
                let version = found.get(item.path)?.version
                if (version) installed.set(version.project_id, { file: item.file, versionId: version.id })
            }
        } catch (err) {
            console.warn('[Modrinth] identification impossible :', err.message)
        }
        // Mods absents de Modrinth sous cette forme : rapprochés par leur identifiant (souvent le slug).
        if (kind === 'mods') {
            for (let mod of items) if (mod.info?.id) installed.set(`slug:${mod.info.id}`, { file: mod.file })
            if (this.instance.fabricApi) installed.set(FABRIC_API_ID, { file: this.instance.fabricApi.filename })
        }
        if (kind !== this.kind) return
        this.installed = installed
        this.renderResults()
        this.renderDetail()
    }

    /** Fichier installé correspondant à un projet (ou null). */
    installedOf(hit) {
        return this.installed.get(hit.project_id) || this.installed.get(`slug:${hit.slug}`) || null
    }

    /* ------------------------------------------------------------------ */
    /* Affichage                                                           */
    /* ------------------------------------------------------------------ */

    iconHTML(hit, cls) {
        return hit.icon_url
            ? `<div class="${cls}" style="background-image:url('${escapeHTML(hit.icon_url)}')"></div>`
            : `<div class="${cls} letter">${escapeHTML(initials(hit.title))}</div>`
    }

    /** Bouton ou badge d'état d'un projet. */
    actionHTML(hit) {
        if (this.busy.has(hit.project_id)) return '<span class="browse-state busy"><span class="browse-spinner"></span></span>'
        if (!this.modpacks && this.installedOf(hit)) return `<span class="browse-state installed" title="Déjà installé">${ICON_CHECK}</span>`
        return `<div class="browse-quick" title="Installer la dernière version compatible">${ICON_DOWNLOAD} Installer</div>`
    }

    renderResults() {
        let list = this.q('.browse-results')
        let text = KIND_TEXT[this.kind]
        if (this.error && !this.hits.length) {
            list.innerHTML = `<div class="mods-empty"><b>Modrinth est injoignable</b>${escapeHTML(this.error)}<div class="browse-retry">Réessayer</div></div>`
            return
        }
        if (!this.hits.length) {
            list.innerHTML = this.loading
                ? '<div class="browse-loading"><span class="browse-spinner"></span> Recherche...</div>'
                : `<div class="mods-empty"><b>Aucun résultat</b>Aucun ${text.one} compatible ne correspond à votre recherche.</div>`
            return
        }
        list.innerHTML = this.hits.map(hit => `
            <div class="browse-card${this.selected?.project_id === hit.project_id ? ' selected' : ''}" data-id="${escapeHTML(hit.project_id)}">
                ${this.iconHTML(hit, 'browse-card-icon')}
                <div class="browse-card-body">
                    <div class="browse-card-title">${escapeHTML(hit.title)} <span>par ${escapeHTML(hit.author)}</span></div>
                    <div class="browse-card-desc">${escapeHTML(hit.description)}</div>
                    <div class="browse-card-meta">
                        <span>${ICON_DOWNLOAD}${compactNumber(hit.downloads)}</span>
                        <span>${ICON_HEART}${compactNumber(hit.follows)}</span>
                        <span>${ICON_CLOCK}${relativeDate(hit.date_modified)}</span>
                    </div>
                </div>
                <div class="browse-card-action">${this.actionHTML(hit)}</div>
            </div>`).join('')
            + (this.loading ? '<div class="browse-loading"><span class="browse-spinner"></span></div>' : '')
            + (!this.loading && this.hits.length >= this.total ? `<div class="browse-end">${this.total} résultat${this.total > 1 ? 's' : ''}</div>` : '')
    }

    /** Sélectionne un projet : détails et versions compatibles. */
    async select(hit) {
        this.selected = hit
        this.detailVersions = null
        this.detailError = null
        this.renderResults()
        this.renderDetail()
        try {
            let { loaders, gameVersion } = this.filter
            let versions = await projectVersions(hit.project_id, { loaders, gameVersions: gameVersion ? [gameVersion] : [] })
            if (this.selected !== hit) return
            this.detailVersions = versions
        } catch (err) {
            if (this.selected !== hit) return
            this.detailVersions = []
            this.detailError = err.message
        }
        this.renderDetail()
    }

    renderDetail() {
        let panel = this.q('.browse-detail')
        let hit = this.selected
        if (!hit) {
            panel.innerHTML = `<div class="browse-detail-empty">Sélectionnez un ${KIND_TEXT[this.kind].one} pour voir ses détails et choisir sa version.</div>`
            return
        }
        let installed = !this.modpacks && this.installedOf(hit)
        let versions = this.detailVersions
        let best = versions && bestVersion(versions)
        let versionLabel = v => {
            let suffix = this.modpacks ? ` · ${v.loaders.map(l => l[0].toUpperCase() + l.slice(1)).join(', ')} ${v.game_versions[v.game_versions.length - 1] || ''}` : ''
            let type = v.version_type === 'release' ? '' : ` (${v.version_type === 'beta' ? 'bêta' : 'alpha'})`
            return `${v.version_number}${type}${suffix}${installed?.versionId === v.id ? ' · installée' : ''}`
        }

        let versionField
        if (!versions) versionField = '<div class="browse-loading small"><span class="browse-spinner"></span> Versions...</div>'
        else if (!versions.length) versionField = `<div class="browse-detail-warn">${this.detailError ? escapeHTML(this.detailError) : 'Aucune version compatible avec cette instance.'}</div>`
        else versionField = `<select class="field-input browse-detail-version">${versions.map(v =>
            `<option value="${escapeHTML(v.id)}"${v === best ? ' selected' : ''}>${escapeHTML(versionLabel(v))}</option>`).join('')}</select>`

        let busy = this.busy.has(hit.project_id)
        let canInstall = versions?.length && !busy
        panel.innerHTML = `
            <div class="browse-detail-scroll">
                <div class="browse-detail-head">
                    ${this.iconHTML(hit, 'browse-detail-icon')}
                    <div>
                        <div class="browse-detail-title">${escapeHTML(hit.title)}</div>
                        <div class="browse-detail-author">par ${escapeHTML(hit.author)}</div>
                    </div>
                </div>
                <div class="browse-detail-desc">${escapeHTML(hit.description)}</div>
                <div class="browse-chips">${(hit.display_categories || hit.categories || []).slice(0, 6).map(c => `<span>${escapeHTML(c)}</span>`).join('')}</div>
                <div class="browse-card-meta">
                    <span>${ICON_DOWNLOAD}${compactNumber(hit.downloads)}</span>
                    <span>${ICON_HEART}${compactNumber(hit.follows)}</span>
                    <span>${ICON_CLOCK}${relativeDate(hit.date_modified)}</span>
                </div>
                <div class="browse-deps"></div>
            </div>
            <div class="browse-detail-footer">
                <label class="field-label">Version</label>
                ${versionField}
                <div class="btn btn-primary browse-detail-install${canInstall ? '' : ' disabled'}">${busy ? 'Installation...' : (installed ? 'Installer cette version' : 'Installer')}</div>
                <a class="browse-detail-link">${ICON_EXTERNAL} Voir sur Modrinth</a>
            </div>`
        this.renderDependencies()
    }

    /** Aperçu des dépendances de la version choisie (mods uniquement). */
    async renderDependencies() {
        let box = this.q('.browse-deps')
        let version = this.detailVersions?.find(v => v.id === this.q('.browse-detail-version')?.value)
        if (!box || !version || this.kind !== 'mods') return
        if (!(version.dependencies || []).some(d => d.dependency_type !== 'embedded')) return
        box.innerHTML = '<div class="browse-loading small"><span class="browse-spinner"></span> Dépendances...</div>'
        try {
            let plan = await resolveDependencies([version], this.context())
            if (this.q('.browse-detail-version')?.value !== version.id) return
            let lines = []
            if (plan.dependencies.length) lines.push(`<div class="browse-dep ok">Installe aussi : <b>${plan.dependencies.map(v => escapeHTML(v.project_title)).join(', ')}</b></div>`)
            if (plan.missing.length) lines.push(`<div class="browse-dep warn">Introuvable pour cette version : <b>${plan.missing.map(escapeHTML).join(', ')}</b></div>`)
            if (plan.conflicts.length) lines.push(`<div class="browse-dep error">Incompatible avec : <b>${plan.conflicts.map(escapeHTML).join(', ')}</b></div>`)
            if (plan.optional.length) lines.push(`<div class="browse-dep muted">Fonctionne aussi avec : ${plan.optional.map(p => escapeHTML(p.title)).join(', ')}</div>`)
            box.innerHTML = lines.join('')
        } catch {
            box.innerHTML = ''
        }
    }

    /** Contexte de résolution des dépendances (projets déjà installés compris). */
    context() {
        let { loaders, gameVersion } = this.filter
        return { loaders, gameVersion, installed: new Set([...this.installed.keys()].filter(k => !k.startsWith('slug:'))) }
    }

    /* ------------------------------------------------------------------ */
    /* Installation                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Installe un projet (version donnée, ou la meilleure version compatible).
     * @param {object} hit Résultat de recherche
     * @param {object} [version]
     */
    async install(hit, version = null) {
        if (this.busy.has(hit.project_id)) return
        let kind = this.kind
        this.setBusy(hit, true)
        let temp = null
        try {
            if (!version) {
                let { loaders, gameVersion } = this.filter
                version = bestVersion(await projectVersions(hit.project_id, { loaders, gameVersions: gameVersion ? [gameVersion] : [] }))
                if (!version) throw new Error(`Aucune version de ${hit.title} n'est compatible.`)
            }
            temp = tempFolder()
            if (kind === 'modpacks') {
                let file = await downloadVersion(version, temp)
                this.setBusy(hit, false)
                if (await this.home.importModpack(file, { iconUrl: hit.icon_url, title: hit.title })) this.close()
                return
            }

            let plan = kind === 'mods' ? await resolveDependencies([version], this.context()) : { dependencies: [], missing: [], conflicts: [] }
            if (!(await this.confirmPlan(hit, version, plan))) return
            let files = []
            for (let v of [...plan.dependencies, version]) files.push(await downloadVersion(v, temp))
            if (kind !== this.kind || !this.editor) return
            await this.editor.importFiles(kind, files)
            await this.refreshInstalled()
        } catch (err) {
            console.error('[Modrinth]', err)
            this.home.showError(`Installation de ${escapeHTML(hit.title)} impossible : ${escapeHTML(err.message)}`)
        } finally {
            if (temp) fs.rmSync(temp, { recursive: true, force: true })
            this.setBusy(hit, false)
        }
    }

    /** Confirmation si l'installation ajoute des dépendances ou pose problème. */
    async confirmPlan(hit, version, plan) {
        if (!plan.dependencies.length && !plan.missing.length && !plan.conflicts.length) return true
        let html = `<b>${escapeHTML(hit.title)}</b> ${escapeHTML(version.version_number)}`
        if (plan.dependencies.length) html += ` a besoin de :${reasonsList(plan.dependencies.map(v => `${v.project_title} ${v.version_number}`), true)}Elles seront installées avec.`
        if (plan.missing.length) html += `<div class="confirm-dialog-warning">Ces dépendances n'existent pas pour cette version du jeu :${reasonsList(plan.missing)}Le mod risque de ne pas se lancer.</div>`
        if (plan.conflicts.length) html += `<div class="confirm-dialog-warning">Ce mod est déclaré incompatible avec un mod déjà installé :${reasonsList(plan.conflicts)}Le jeu risque de ne pas démarrer.</div>`
        let { confirmed } = await confirmDialog({
            title: plan.dependencies.length && !plan.conflicts.length ? 'Installer avec ses dépendances ?' : 'Installer quand même ?',
            html,
            confirmText: plan.dependencies.length ? `Installer (${plan.dependencies.length + 1})` : 'Installer',
            danger: plan.conflicts.length > 0
        })
        return confirmed
    }

    setBusy(hit, busy) {
        if (busy) this.busy.add(hit.project_id)
        else this.busy.delete(hit.project_id)
        this.renderResults()
        if (this.selected?.project_id === hit.project_id) {
            let button = this.q('.browse-detail-install')
            if (button) {
                button.classList.toggle('disabled', busy || !this.detailVersions?.length)
                button.textContent = busy ? 'Installation...' : (this.installedOf(hit) ? 'Installer cette version' : 'Installer')
            }
        }
    }
}
