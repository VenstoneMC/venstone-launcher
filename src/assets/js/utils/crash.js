/**
 * Plantages du jeu : sortie de la partie gardée en mémoire, rapport de plantage écrit pendant la
 * session, et causes fréquentes reconnues avec un conseil pour chacune.
 */

const fs = require('fs');
const path = require('path');

/** Taille gardée de la sortie du jeu (la fin suffit pour comprendre un plantage). */
const OUTPUT_LIMIT = 400 * 1024;

/**
 * Java n'a pas démarré (option invalide, mémoire impossible...) : le jeu est déjà arrêté, même si
 * l'événement de fermeture de minecraft-java-core n'arrive que plusieurs secondes plus tard.
 */
export const JVM_START_FAILED = /Unrecognized VM option|Could not create the Java Virtual Machine|Error occurred during initialization of VM|Invalid (?:maximum|initial) heap size|Could not reserve enough space for object heap/;

/** Sortie du jeu (stdout + stderr), seulement la fin. */
export class GameOutput {
    constructor() {
        this.text = '';
    }

    push(chunk) {
        this.text += chunk;
        if (this.text.length > OUTPUT_LIMIT * 1.5) this.text = this.text.slice(-OUTPUT_LIMIT);
    }
}

/** Lignes qui suivent une ligne d'en-tête et commencent par « - » (listes Fabric). */
function listAfter(text, index, max = 5) {
    return text.slice(index).split(/\r?\n/).slice(1)
        .map(l => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)?:?\s*/, '').trim())
        .filter(l => /^-\s/.test(l))
        .slice(0, max)
        .map(l => l.replace(/^-\s*/, ''));
}

/**
 * Causes reconnues, de la plus précise à la plus générale.
 * `details(text, match)` renvoie des lignes à afficher (optionnel).
 */
const CAUSES = [
    {
        test: /Could not reserve enough space for object heap|Invalid (?:maximum|initial) heap size|Initial heap size set to a larger value/,
        title: 'Mémoire allouée invalide',
        advice: "Java n'a pas pu réserver la mémoire demandée. Baissez la mémoire allouée dans les réglages, ou vérifiez que Java est en 64 bits."
    },
    {
        test: /Unrecognized VM option '([^']+)'|Could not create the Java Virtual Machine|Error occurred during initialization of VM/,
        title: "Java n'a pas pu démarrer",
        advice: "Un argument JVM est invalide. Vérifiez les arguments JVM dans les réglages de l'instance et dans ceux du launcher.",
        details: (text, match) => (match[1] ? [`Option refusée : ${match[1]}`] : [])
    },
    {
        test: /java\.lang\.OutOfMemoryError/,
        title: 'Mémoire insuffisante',
        advice: "Le jeu a manqué de mémoire. Augmentez la mémoire allouée dans les réglages de l'instance (ou du launcher), sans dépasser la moitié de la RAM de votre PC."
    },
    {
        test: /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime|requires (?:at least )?Java \d+/,
        title: 'Mauvaise version de Java',
        advice: "Le jeu ou un mod demande une version de Java plus récente. Remettez Java en automatique dans les réglages de l'instance et du launcher."
    },
    {
        test: /Incompatible mods? (?:found|set)|incompatible mod set/i,
        title: 'Mods incompatibles',
        advice: 'Fabric a refusé de démarrer à cause des mods suivants. Mettez-les à jour, ou désactivez-les dans l\'onglet Mods.',
        details: (text, match) => listAfter(text, match.index)
    },
    {
        test: /Missing or unsupported mandatory dependencies/,
        title: 'Dépendance manquante',
        advice: "Un mod a besoin d'un autre mod qui n'est pas installé (ou pas dans la bonne version). Installez-le depuis « Parcourir Modrinth »."
    },
    {
        test: /Duplicate mods? found|Found duplicate mod|DuplicateModsFoundException/i,
        title: 'Mod en double',
        advice: "Le même mod est installé deux fois (souvent deux versions). Supprimez l'une des deux dans l'onglet Mods.",
        details: (text, match) => listAfter(text, match.index)
    },
    {
        test: /Mixin apply for mod (\S+) failed|MixinApplyError|InvalidInjectionException|Mixin transformation of .* failed/,
        title: 'Mod incompatible',
        advice: "Un mod n'est pas compatible avec cette version du jeu ou avec un autre mod. Mettez-le à jour ou désactivez-le.",
        details: (text, match) => (match[1] ? [`Mod en cause : ${match[1]}`] : [])
    },
    {
        test: /GLFW error 65542|Pixel format not accelerated|driver does not appear to support OpenGL|OpenGL 3\.2 or later/i,
        title: 'Pilote graphique',
        advice: 'Votre carte graphique ou son pilote ne prend pas en charge OpenGL. Mettez à jour le pilote depuis le site du fabricant (NVIDIA, AMD, Intel).'
    },
    {
        test: /EXCEPTION_ACCESS_VIOLATION|A fatal error has been detected by the Java Runtime/,
        title: 'Plantage de Java',
        advice: 'Ce type de plantage vient souvent des shaders ou du pilote graphique. Essayez sans shaders et mettez à jour le pilote graphique.'
    }
];

/**
 * Rapport de plantage écrit depuis le lancement : crash-reports/ de Minecraft, ou hs_err_pid*.log
 * de Java pour un plantage natif.
 * @param {string} instanceDir
 * @param {number} since Date du lancement (ms)
 * @returns {string|null}
 */
export function findCrashReport(instanceDir, since) {
    let candidates = [];
    let collect = (dir, filter) => {
        try {
            for (let name of fs.readdirSync(dir)) {
                if (!filter(name)) continue;
                let file = path.join(dir, name);
                let time = fs.statSync(file).mtimeMs;
                if (time >= since) candidates.push({ file, time });
            }
        } catch { /* dossier absent */ }
    };
    collect(path.join(instanceDir, 'crash-reports'), n => n.endsWith('.txt'));
    collect(instanceDir, n => /^hs_err_pid\d+\.log$/.test(n));
    return candidates.sort((a, b) => b.time - a.time)[0]?.file || null;
}

/** Ligne « Description: » d'un rapport Minecraft (« Rendering overlay »...). */
function reportDescription(report) {
    return report.match(/^Description: (.+)$/m)?.[1]?.trim() || null;
}

/**
 * Analyse un plantage.
 * @param {{output: string, report?: string|null}} input Sortie du jeu et contenu du rapport
 * @returns {{title: string, advice: string, details: string[]}|null} null si rien n'indique un plantage
 */
export function analyzeCrash({ output, report = null }) {
    let text = `${report || ''}\n${output || ''}`;
    for (let cause of CAUSES) {
        let match = text.match(cause.test);
        if (match) return { title: cause.title, advice: cause.advice, details: cause.details?.(text, match) || [] };
    }
    if (!report) return null;
    let description = reportDescription(report);
    return {
        title: "Le jeu s'est arrêté",
        advice: 'Minecraft a planté sans cause connue. Le rapport de plantage indique ce qui s\'est passé, il peut aider sur le Discord Venstone.',
        details: description ? [`Description : ${description}`] : []
    };
}
