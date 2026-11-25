/**
 * Lecture et écriture d'archives zip, asynchrones (l'interface reste fluide pendant l'import
 * ou l'export d'un modpack). Pas de zip64 : archives de moins de 4 Go et 65 535 entrées.
 */

const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);
const deflateRaw = promisify(zlib.deflateRaw);

/* ------------------------------------------------------------------ */
/* CRC-32                                                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
    let table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

/**
 * CRC-32 d'un buffer.
 * @param {Buffer} buf
 * @returns {number}
 */
export function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Liste les entrées d'une archive.
 * @param {string} file
 * @returns {Promise<Array<{name: string, dir: boolean, method: number, compSize: number, size: number, localOffset: number}>>}
 */
export async function listZip(file) {
    let fh = await fs.promises.open(file, 'r');
    try {
        let { size } = await fh.stat();
        let tailLen = Math.min(size, 65557);
        let tail = Buffer.alloc(tailLen);
        await fh.read(tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error("ce fichier n'est pas une archive valide");

        let count = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);
        if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) throw new Error('archive zip64 non prise en charge');
        let cd = Buffer.alloc(cdSize);
        await fh.read(cd, 0, cdSize, cdOffset);

        let entries = [];
        let p = 0;
        for (let i = 0; i < count && p + 46 <= cd.length; i++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) break;
            let nameLen = cd.readUInt16LE(p + 28);
            let name = cd.toString('utf8', p + 46, p + 46 + nameLen).split('\\').join('/');
            entries.push({
                name,
                dir: name.endsWith('/'),
                method: cd.readUInt16LE(p + 10),
                compSize: cd.readUInt32LE(p + 20),
                size: cd.readUInt32LE(p + 24),
                localOffset: cd.readUInt32LE(p + 42)
            });
            p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
        }
        return entries;
    } finally {
        await fh.close();
    }
}

/**
 * Lit (et décompresse) une entrée listée par `listZip`.
 * @param {string} file
 * @param {object} entry
 * @returns {Promise<Buffer>}
 */
export async function readZipEntry(file, entry) {
    let fh = await fs.promises.open(file, 'r');
    try {
        let local = Buffer.alloc(30);
        await fh.read(local, 0, 30, entry.localOffset);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`entrée corrompue : ${entry.name}`);
        let start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        let data = Buffer.alloc(entry.compSize);
        await fh.read(data, 0, entry.compSize, start);
        if (entry.method === 0) return data;
        if (entry.method === 8) return await inflateRaw(data);
        throw new Error(`méthode de compression non prise en charge : ${entry.name}`);
    } finally {
        await fh.close();
    }
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

/** Extensions déjà compressées : stockées telles quelles (plus rapide, même taille). */
const STORED = /\.(jar|zip|png|jpe?g|gif|webp|ogg|mp3|gz|7z|mrpack|disabled)$/i;

/** Date et heure au format DOS. */
function dosDateTime(date = new Date()) {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

/**
 * Écrit une archive zip entrée par entrée (chaque fichier est lu, compressé puis écrit).
 *
 *   let zip = await ZipWriter.create('pack.mrpack')
 *   await zip.add('modrinth.index.json', Buffer.from(json))
 *   await zip.close()
 */
export class ZipWriter {
    /** @param {fs.promises.FileHandle} fh */
    constructor(fh) {
        this.fh = fh;
        this.offset = 0;
        this.central = [];
    }

    /**
     * Ouvre (écrase) le fichier de destination.
     * @param {string} file
     */
    static async create(file) {
        return new ZipWriter(await fs.promises.open(file, 'w'));
    }

    async write(buf) {
        await this.fh.write(buf, 0, buf.length, this.offset);
        this.offset += buf.length;
    }

    /**
     * Ajoute un fichier.
     * @param {string} name Chemin dans l'archive (séparateur « / »)
     * @param {Buffer} data
     * @param {Date} [mtime]
     */
    async add(name, data, mtime) {
        if (this.central.length >= 0xFFFF) throw new Error("trop de fichiers pour l'archive (65 535 maximum)");
        let crc = crc32(data);
        let method = 0;
        let body = data;
        if (!STORED.test(name) && data.length > 64) {
            let deflated = await deflateRaw(data, { level: 6 });
            if (deflated.length < data.length) { method = 8; body = deflated; }
        }
        if (this.offset + body.length > 0xFFFFFFF0) throw new Error("l'archive dépasse 4 Go");

        let nameBuf = Buffer.from(name, 'utf8');
        let { time, date } = dosDateTime(mtime);
        let header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6); // noms en UTF-8
        header.writeUInt16LE(method, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(body.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuf.length, 26);
        header.writeUInt16LE(0, 28);

        let localOffset = this.offset;
        await this.write(Buffer.concat([header, nameBuf]));
        await this.write(body);

        let cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0x0800, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt16LE(time, 12);
        cd.writeUInt16LE(date, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(body.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(localOffset, 42);
        this.central.push(Buffer.concat([cd, nameBuf]));
    }

    /** Écrit le répertoire central et ferme le fichier. */
    async close() {
        try {
            let cdOffset = this.offset;
            let cd = Buffer.concat(this.central);
            await this.write(cd);
            let end = Buffer.alloc(22);
            end.writeUInt32LE(0x06054b50, 0);
            end.writeUInt16LE(this.central.length, 8);
            end.writeUInt16LE(this.central.length, 10);
            end.writeUInt32LE(cd.length, 12);
            end.writeUInt32LE(cdOffset, 16);
            await this.write(end);
        } finally {
            await this.fh.close();
        }
    }

    /** Ferme le fichier sans finaliser l'archive (en cas d'erreur). */
    async abort() {
        try { await this.fh.close(); } catch { }
    }
}
