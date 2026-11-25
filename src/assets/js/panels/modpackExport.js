/**
 * Fenêtre d'export d'une instance personnelle en modpack Modrinth (.mrpack) :
 * nom, version, description et choix des fichiers / dossiers à inclure (comme sur Modrinth).
 * Les réglages du dernier export sont mémorisés dans l'instance.
 */

import { escapeHTML } from '../utils/instanceForm.js'
import { confirmDialog } from '../utils/dialog.js'
import { instanceFolder, sanitizeName, updateLocalInstance } from '../utils/instances.js'
import { exportTree, exportModpack, formatSize } from '../utils/mrpack.js'

const { ipcRenderer, shell } = require('electron')
const path = require('path')

const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z"/></svg>'

export default class ModpackExport {
    /** @param {object} editor InstanceEditor */
    constructor(editor) {
        this.editor = editor
        this.home = editor.home
        this.root = document.querySelector('.export-popup')
        this.tree = []
        this.busy = false
        this.bind()
    }

    q(selector) {
        return this.root.querySelector(selector)
    }

    bind() {
        let close = () => this.close()
        this.q('.export-close').addEventListener('click', close)
        this.q('.export-cancel').addEventListener('click', close)
        this.q('.export-back').addEventListener('click', close)
        this.root.addEventListener('mousedown', e => { if (e.target === this.root) close() })
        this.q('.export-submit').addEventListener('click', () => this.submit())
        ;['.export-name', '.export-version'].forEach(s => this.q(s).addEventListener('input', () => this.update()))

        let tree = this.q('.export-tree')
        tree.addEventListener('click', e => {
            let expand = e.target.closest('.export-expand')
            if (!expand) return
            let node = this.tree[Number(expand.closest('.export-node').dataset.index)]
            node.open = !node.open
            this.render()
        })
        tree.addEventListener('change', e => {
            let box = e.target.closest('input[type="checkbox"]')
            if (!box) return
            let node = this.tree[Number(box.closest('.export-node').dataset.index)]
            let child = box.dataset.child !== undefined ? node.children[Number(box.dataset.child)] : null
            if (child) {
                child.checked = box.checked
                node.checked = node.children.every(c => c.checked)
            } else {
                node.checked = box.checked
                node.children.forEach(c => c.checked = box.checked)
            }
            this.render()
        })
    }

    /** Ouvre la fenêtre pour l'instance de l'éditeur. */
    open() {
        let instance = this.editor.instance
        let saved = instance.modpackExport || {}
        this.q('.export-name').value = saved.name || instance.name
        this.q('.export-version').value = saved.version || '1.0.0'
        this.q('.export-summary').value = saved.summary || ''
        this.setStatus('')

        let dir = instanceFolder(this.home.gamePath, instance)
        this.tree = exportTree(dir).map(node => {
            let children = node.children.map(c => ({ ...c, checked: node.checked }))
            if (Array.isArray(saved.selection)) {
                let selected = new Set(saved.selection)
                let whole = selected.has(node.name)
                children.forEach(c => c.checked = whole || selected.has(`${node.name}/${c.name}`))
                node.checked = whole || (children.length > 0 && children.every(c => c.checked))
            }
            return { ...node, children, open: false }
        })
        this.render()
        this.home.openPopup('.export-popup')
        setTimeout(() => this.q('.export-name').focus(), 50)
    }

    close() {
        if (this.busy) return
        this.home.closePopup('.export-popup')
    }

    /** Chemins relatifs sélectionnés (un dossier entièrement coché = le dossier). */
    selection() {
        let out = []
        for (let node of this.tree) {
            if (node.checked) out.push(node.name)
            else out.push(...node.children.filter(c => c.checked).map(c => `${node.name}/${c.name}`))
        }
        return out
    }

    render() {
        let tree = this.q('.export-tree')
        if (!this.tree.length) {
            tree.innerHTML = '<div class="export-empty">Cette instance ne contient encore aucun fichier.<br>Lancez-la une première fois ou ajoutez des mods.</div>'
            return this.update()
        }
        tree.innerHTML = this.tree.map((node, i) => {
            let some = !node.checked && node.children.some(c => c.checked)
            let expandable = node.dir && node.children.length > 0
            let children = expandable && node.open ? `<div class="export-children">${node.children.map((c, j) => `
                <label class="export-row export-child">
                    <input type="checkbox" data-child="${j}"${c.checked ? ' checked' : ''}/>
                    <span class="export-ico">${c.dir ? ICON_FOLDER : ICON_FILE}</span>
                    <span class="export-label">${escapeHTML(c.name)}</span>
                </label>`).join('')}</div>` : ''
            return `
                <div class="export-node${node.open ? ' open' : ''}" data-index="${i}">
                    <div class="export-row">
                        <label class="export-main">
                            <input type="checkbox"${node.checked ? ' checked' : ''}${some ? ' data-some="1"' : ''}/>
                            <span class="export-ico">${node.dir ? ICON_FOLDER : ICON_FILE}</span>
                            <span class="export-label">${escapeHTML(node.name)}</span>
                        </label>
                        ${expandable ? `<span class="export-expand" title="${node.open ? 'Replier' : 'Choisir les fichiers'}"><span class="export-chevron"></span><span class="export-sub-count">${node.children.length}</span></span>` : ''}
                    </div>
                    ${children}
                </div>`
        }).join('')
        tree.querySelectorAll('input[data-some]').forEach(input => input.indeterminate = true)
        this.update()
    }

    /** Compteur de sélection et état du bouton Exporter. */
    update() {
        let count = this.selection().length
        this.q('.export-files-count').textContent = count ? `${count} élément${count > 1 ? 's' : ''}` : 'Rien de sélectionné'
        let ready = count > 0 && this.q('.export-name').value.trim() && this.q('.export-version').value.trim()
        this.q('.export-submit').classList.toggle('disabled', !ready || this.busy)
    }

    setStatus(text, error = false) {
        let status = this.q('.export-status')
        status.textContent = text
        status.classList.toggle('error', error)
    }

    /** Demande où enregistrer puis crée le .mrpack. */
    async submit() {
        if (this.busy || this.q('.export-submit').classList.contains('disabled')) return
        let instance = this.editor.instance
        let name = this.q('.export-name').value.trim()
        let version = this.q('.export-version').value.trim()
        let summary = this.q('.export-summary').value.trim()
        let selection = this.selection()

        let downloads = await ipcRenderer.invoke('path-downloads')
        let fileName = `${sanitizeName(name) || 'modpack'} ${version.replace(/[<>:"/\\|?*\x00-\x1F]/g, '')}`.trim()
        let { canceled, filePath } = await ipcRenderer.invoke('save-dialog', {
            title: 'Exporter le modpack',
            defaultPath: path.join(downloads, `${fileName}.mrpack`),
            filters: [{ name: 'Modpack Modrinth', extensions: ['mrpack'] }]
        })
        if (canceled || !filePath) return
        if (!/\.mrpack$/i.test(filePath)) filePath += '.mrpack'

        this.busy = true
        this.root.classList.add('busy')
        this.update()
        try {
            let result = await exportModpack({
                instance,
                dir: instanceFolder(this.home.gamePath, instance),
                output: filePath,
                name, version, summary, selection,
                onProgress: text => this.setStatus(text)
            })
            // Réglages mémorisés pour le prochain export.
            try {
                this.editor.instance = await updateLocalInstance(instance.name, { modpackExport: { name, version, summary, selection } })
            } catch (err) {
                console.warn('[Export] réglages non mémorisés :', err)
            }
            this.busy = false
            this.root.classList.remove('busy')
            this.close()

            let { confirmed } = await confirmDialog({
                title: 'Modpack exporté',
                icon: '✓',
                html: `<b>${escapeHTML(path.basename(filePath))}</b> (${formatSize(result.size)}) a été créé.<br>
                    ${result.linked} fichier${result.linked > 1 ? 's' : ''} référencé${result.linked > 1 ? 's' : ''} depuis Modrinth, ${result.included} inclus dans le modpack.
                    ${result.offline ? '<div class="confirm-dialog-warning">Modrinth était injoignable : tous les mods ont été inclus dans le fichier, il est donc plus lourd.</div>' : ''}`,
                confirmText: 'Afficher le fichier',
                cancelText: 'Fermer'
            })
            if (confirmed) shell.showItemInFolder(filePath)
        } catch (err) {
            console.error('[Export]', err)
            this.setStatus(`Export impossible : ${err.message}`, true)
        } finally {
            this.busy = false
            this.root.classList.remove('busy')
            this.update()
        }
    }
}
