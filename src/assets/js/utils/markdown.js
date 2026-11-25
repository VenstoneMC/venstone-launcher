/**
 * Descriptions Modrinth (Markdown avec du HTML) affichées dans le launcher.
 *
 * Le texte vient des auteurs de projets : seul un ensemble réduit de balises et d'attributs est
 * gardé (pas de style, de script, de formulaire ni de cadre). Les liens s'ouvrent dans le
 * navigateur (voir ModrinthBrowser), les vidéos intégrées deviennent des liens.
 */

const { marked } = require('marked')

/** Balises supprimées avec leur contenu. */
const DROP = new Set(['script', 'style', 'link', 'meta', 'base', 'title', 'object', 'embed', 'form', 'input', 'button',
    'textarea', 'select', 'option', 'noscript', 'template', 'svg', 'math', 'video', 'audio', 'canvas', 'frame', 'frameset'])

/** Balises gardées (les autres sont remplacées par leur contenu). */
const KEEP = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
    'ins', 'mark', 'sub', 'sup', 'small', 'code', 'pre', 'kbd', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table',
    'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'details', 'summary', 'center', 'div', 'span', 'figure', 'figcaption'])

/** Attributs gardés, par balise (`*` : toutes). */
const ATTRS = {
    '*': ['align', 'title'],
    a: ['href'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    ol: ['start'],
    details: ['open']
}

const safeUrl = (value, schemes) => {
    try {
        return schemes.includes(new URL(value).protocol)
    } catch {
        return false
    }
}

/** Nettoie un nœud et ses descendants (en place). */
function clean(node) {
    for (let child of [...node.childNodes]) {
        if (child.nodeType === 8) { // commentaire
            child.remove()
            continue
        }
        if (child.nodeType !== 1) continue
        let tag = child.tagName.toLowerCase()

        if (tag === 'iframe') {
            // Vidéo YouTube ou autre intégration : un simple lien vers la page.
            let src = child.getAttribute('src') || ''
            if (safeUrl(src, ['https:'])) {
                let link = node.ownerDocument.createElement('a')
                link.href = src.replace(/youtube(?:-nocookie)?\.com\/embed\//, 'youtube.com/watch?v=')
                link.textContent = /youtu/.test(src) ? 'Voir la vidéo' : 'Voir le contenu intégré'
                link.className = 'md-embed'
                child.replaceWith(link)
            } else child.remove()
            continue
        }
        if (DROP.has(tag)) {
            child.remove()
            continue
        }

        clean(child)
        if (!KEEP.has(tag)) {
            child.replaceWith(...child.childNodes)
            continue
        }

        let allowed = [...ATTRS['*'], ...(ATTRS[tag] || [])]
        for (let attr of [...child.attributes]) if (!allowed.includes(attr.name)) child.removeAttribute(attr.name)
        if (tag === 'a') {
            let href = child.getAttribute('href') || ''
            if (!safeUrl(href, ['https:', 'http:', 'mailto:'])) child.removeAttribute('href')
        }
        if (tag === 'img') {
            if (!safeUrl(child.getAttribute('src') || '', ['https:'])) {
                child.remove()
                continue
            }
            child.setAttribute('loading', 'lazy')
            child.setAttribute('draggable', 'false')
        }
    }
}

/**
 * Markdown Modrinth vers du HTML sûr.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
    let html = marked.parse(String(text || ''), { async: false, gfm: true })
    let doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
    clean(doc.body)
    return doc.body.innerHTML
}
