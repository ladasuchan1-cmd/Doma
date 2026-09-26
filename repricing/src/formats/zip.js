'use strict';
// ZIP bez závislostí (pro XLSX): čtení přes centrální adresář (store/deflate, datové deskriptory) a zápis.
// ZIP64 a šifrované archivy se odmítají se srozumitelnou chybou.

const zlib = require('node:zlib');
const { constants: bufferConstants } = require('node:buffer');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

function zipError(message, code = 'ZIP_INVALID') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      // komentář archivu musí sedět s délkou souboru (jinak jde o náhodnou shodu uvnitř dat)
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buf.length) return i;
    }
  }
  return -1;
}

/**
 * Přečte ZIP archiv. Obsah položek se dekomprimuje líně až při zavolání funkce.
 * @param {Buffer} buf
 * @returns {Map<string, () => Buffer>} název souboru → funkce vracející obsah
 * @throws {Error} code ZIP_INVALID | ZIP64_UNSUPPORTED | ZIP_ENCRYPTED | ZIP_METHOD_UNSUPPORTED | ZIP_CORRUPT
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) {
    if (buf && ArrayBuffer.isView(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    else if (buf instanceof ArrayBuffer) buf = Buffer.from(buf);
    else throw zipError('readZip: očekáván Buffer');
  }
  if (buf.length < 22) throw zipError('Soubor není platný ZIP/XLSX (příliš krátký).');
  const eocd = findEocd(buf);
  if (eocd === -1) throw zipError('Soubor není platný ZIP/XLSX (chybí konec centrálního adresáře – soubor je poškozený nebo useknutý).');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (
    total === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR)
  ) {
    throw zipError('Formát ZIP64 (soubory nad 4 GB / více než 65 535 položek) není podporován.', 'ZIP64_UNSUPPORTED');
  }
  if (cdOffset + cdSize > eocd) throw zipError('Poškozený ZIP: centrální adresář mimo soubor.', 'ZIP_CORRUPT');

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw zipError('Poškozený ZIP: chybná položka centrálního adresáře.', 'ZIP_CORRUPT');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw zipError('Poškozený ZIP: název položky mimo soubor.', 'ZIP_CORRUPT');
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      throw zipError('Formát ZIP64 (soubory nad 4 GB) není podporován.', 'ZIP64_UNSUPPORTED');
    }
    if (name.endsWith('/')) continue; // adresář
    if (flags & 0x1 || flags & 0x40) throw zipError(`Šifrovaný ZIP není podporován (položka „${name}“) – uložte soubor bez hesla.`, 'ZIP_ENCRYPTED');
    if (method !== 0 && method !== 8) {
      throw zipError(`Nepodporovaná komprese ZIP (metoda ${method}) u položky „${name}“.`, 'ZIP_METHOD_UNSUPPORTED');
    }
    if (entries.has(name)) continue; // duplicitní název – platí první výskyt
    entries.set(name, () => extract(buf, name, { method, crc, csize, usize, localOffset }));
  }
  return entries;
}

// Nejvyšší velikost rozbalené položky (ZIP i XLSX). Rozbalená data se dekódují na jeden JS řetězec a parsují;
// deklarovaná velikost se jinak bere z centrálního adresáře (až 4 GB) a 2MB „zip bomba“ zaplnila paměť
// a na desítky sekund zablokovala server (ops-3, security-2). Sdílí i gzip v import/records.js.
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
// Poměr komprese nad tuto mez u velké položky = téměř jistě bomba (reálné CSV/XML se komprimují ~5–20×).
const MAX_RATIO = 1000;
const RATIO_MIN_BYTES = 50 * 1024 * 1024;

function extract(buf, name, e) {
  if (e.usize > MAX_ENTRY_BYTES) {
    throw zipError(
      `Položka „${name}“ je po rozbalení příliš velká (${Math.round(e.usize / 1024 / 1024)} MB, nejvýše ${MAX_ENTRY_BYTES / 1024 / 1024} MB).`,
      'ZIP_TOO_LARGE'
    );
  }
  if (e.method !== 0 && e.usize > RATIO_MIN_BYTES && e.usize / Math.max(e.csize, 1) > MAX_RATIO) {
    throw zipError(`Položka „${name}“ má nepřirozeně vysoký poměr komprese – soubor odmítnut.`, 'ZIP_TOO_LARGE');
  }
  const lo = e.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOCAL) throw zipError(`Poškozený ZIP: chybí lokální hlavička „${name}“.`, 'ZIP_CORRUPT');
  // délky názvu/extra v lokální hlavičce se mohou lišit od centrálního adresáře; velikosti bereme z centrálního
  // adresáře (u datových deskriptorů jsou v lokální hlavičce nuly).
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const end = start + e.csize;
  if (end > buf.length) throw zipError(`Poškozený ZIP: data položky „${name}“ jsou useknutá.`, 'ZIP_CORRUPT');
  const raw = buf.subarray(start, end);
  let data;
  if (e.method === 0) data = raw;
  else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(Math.max(e.usize, 1), MAX_ENTRY_BYTES, bufferConstants.MAX_LENGTH) });
    } catch (err) {
      throw zipError(`Poškozený ZIP: položku „${name}“ nelze rozbalit (${err.message}).`, 'ZIP_CORRUPT');
    }
  }
  if (data.length !== e.usize) throw zipError(`Poškozený ZIP: nesouhlasí velikost položky „${name}“.`, 'ZIP_CORRUPT');
  if (zlib.crc32(data) >>> 0 !== e.crc >>> 0) throw zipError(`Poškozený ZIP: nesouhlasí kontrolní součet položky „${name}“.`, 'ZIP_CORRUPT');
  return data;
}

function dosDateTime(d) {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Vytvoří ZIP archiv (deflate; položky, které se kompresí nezmenší, se uloží bez komprese).
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {{date?: Date, level?: number}} [opts]
 * @returns {Buffer}
 */
function writeZip(entries, opts = {}) {
  if (entries.length > 0xfffe) throw zipError('Příliš mnoho položek pro ZIP (max. 65 534).', 'ZIP64_UNSUPPORTED');
  const { time, date } = dosDateTime(opts.date ? new Date(opts.date) : new Date());
  const chunks = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw zipError('Položka ZIP musí mít název.');
    if (names.has(name)) throw zipError(`Duplicitní položka ZIP „${name}“.`);
    names.add(name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data == null ? '' : String(entry.data), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const utf8 = /[^\x20-\x7e]/.test(name);
    const crc = zlib.crc32(data) >>> 0;
    let method = 8;
    let payload = data.length ? zlib.deflateRawSync(data, { level: opts.level ?? 6 }) : Buffer.alloc(0);
    if (payload.length >= data.length) {
      method = 0;
      payload = data;
    }
    if (payload.length > 0xfffffffe || data.length > 0xfffffffe || offset > 0xfffffffe) {
      throw zipError('Soubor je příliš velký pro ZIP bez ZIP64 (max. 4 GB).', 'ZIP64_UNSUPPORTED');
    }
    const flags = utf8 ? 0x800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // verze potřebná pro rozbalení 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4); // vytvořeno verzí 2.0 (MS-DOS)
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    // extra, komentář, disk, interní atributy = 0
    cd.writeUInt32LE(0, 38); // externí atributy
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

module.exports = { readZip, writeZip, MAX_ENTRY_BYTES };
