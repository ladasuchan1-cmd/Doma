// Investiční škola – malý server bez závislostí: přihlášení jedním heslem, stránka průvodce a deník obchodů.
//
// Proměnné prostředí:
//   PORT              výchozí 8095
//   INV_HESLO_HASH    otisk hesla (vytvoří `node server.js --hash`, heslo čte ze stdin); bez něj se nejde přihlásit
//   INV_DATA          složka pro deník a klíč cookie (výchozí ./data, v kontejneru /data)
//   INV_TRUST_PROXY   "1" = adresu klienta brát z X-Forwarded-For (server stojí za Caddy)
//   APP_VERSION       verze z gitu, ukazuje ji /api/health
//   ANTHROPIC_API_KEY klíč ke Claude API pro Překladač (bez něj překladač na serveru neběží)
//   INV_PREKLAD_LIMIT kolik překladů měsíčně smí server udělat (výchozí 300; brzda útraty)
//   MAIL_USER, MAIL_PASSWORD, MAIL_TO, SMTP_HOST, SMTP_PORT  pošta pro upozornění a týdenní zálohu (viz posta.js)
//   INV_POHYB_PRAH    od kolika procent denní změny sledovaného titulu poslat upozornění (výchozí 5)
//   INV_ADRESA        adresa webu do odkazů v e-mailech (např. https://investice.ksprehledy.cz)
//   INV_HLIDAC        "0" = nehlídat stop a cíl zkušebních obchodů (výchozí: hlídat každou minutu)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { yahoo, platnySym, ROZSAHY } = require('./trh.js');
const { zdroje: ctecZdroju, platnaAdresa, typZdroje } = require('./zdroje.js');
const { prekladac, vytahniPokyn, textZeStranky, MAX_ZNAKU } = require('./preklad.js');
const { posta: vytvorPostu } = require('./posta.js');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function hashHesla(heslo) {
  const sul = crypto.randomBytes(16);
  const h = crypto.scryptSync(heslo, sul, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, sul.toString('base64'), h.toString('base64')].join(':');
}

function overHeslo(heslo, otisk) {
  const c = String(otisk || '').split(':');
  if (c.length !== 6 || c[0] !== 'scrypt') return Promise.resolve(false);
  const [N, r, p] = [c[1], c[2], c[3]].map(Number);
  const sul = Buffer.from(c[4], 'base64');
  const cil = Buffer.from(c[5], 'base64');
  if (!(N > 1 && N <= 1048576) || !(r > 0 && r <= 16) || !(p > 0 && p <= 4) || cil.length < 16) return Promise.resolve(false);
  return new Promise((ok) => {
    crypto.scrypt(String(heslo), sul, cil.length, { N, r, p, maxmem: 256 * 1024 * 1024 }, (e, h) => {
      ok(!e && h.length === cil.length && crypto.timingSafeEqual(h, cil));
    });
  });
}

if (require.main === module && process.argv[2] === '--hash') {
  const heslo = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!heslo) { console.error('Heslo je prázdné.'); process.exit(1); }
  process.stdout.write(hashHesla(heslo) + '\n');
  process.exit(0);
}

const TITUL = 'Prvních 10 000 na burze';
const RESET = 'html{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}';
const HLAVA = (titul) => `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>${titul}</title><style>${RESET}</style></head><body>`;

const POLE_NOVY = ['t', 'd', 'mode', 'size', 'entry', 'stop', 'target', 'fees', 'why'];
const MAX_OBCHODU = 2000;
const MAX_TELO = 16 * 1024;
const POKUSY_MAX = 10;
const POKUSY_OKNO = 15 * 60 * 1000;
const PLATNOST = 30 * 24 * 3600 * 1000;
const BENCHMARK = 'VWCE.DE'; // ETF z prvního koše – proti němu se zkušební obchody měří
const SLEDOVANE_VYCHOZI = [BENCHMARK, 'NVDA', 'CEZ.PR', 'MSFT', 'AMD'];
const MAX_SLEDOVANYCH = 30;
const MAX_ZDROJU = 40;
// Výchozí zdroj je příklad, který si uživatel vyžádal; poznámka říká, kdo to je a z čeho žije (údaje z webu firmy, 11/2026).
const ZDROJE_VYCHOZI = [{
  id: 'vychozi-purple', nazev: 'Purple Trading', url: 'https://www.facebook.com/purpletrading.cz/', typ: 'facebook', feed: null,
  pozn: 'Broker forexu a CFD (L.F. Investment Limited, Kypr, dohled CySEC). Vydělává na tom, že jeho klienti obchodují. Sám uvádí, že u něj na CFD přichází o kapitál 74,37 % účtů drobných investorů. Čti jako reklamu obchodníka, ne jako nezávislou radu.',
  pridano: '2026-11-15',
}];
const CERSTVY_KURZ = 20 * 60; // s; starší kurz = burza je zavřená, zkušební nákup ani prodej se neprovede
const SNIMKU = 60; // kolik denních snímků deníku se drží ve složce dat
const cz = (n, d = 0) => Number(n).toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
const seZnamenkem = (n, d, jednotka) => (n > 0 ? '+' : n < 0 ? '−' : '') + cz(Math.abs(n), d) + ' ' + jednotka;

function vytvor(opts = {}) {
  const dataDir = opts.dataDir || process.env.INV_DATA || path.join(__dirname, 'data');
  const otisk = opts.hash !== undefined ? opts.hash : (process.env.INV_HESLO_HASH || '');
  const trustProxy = opts.trustProxy !== undefined ? opts.trustProxy : process.env.INV_TRUST_PROXY === '1';
  const verze = process.env.APP_VERSION || 'vývoj';
  const trh = opts.trh || yahoo();
  const ctec = opts.zdroje || ctecZdroju();
  const preklad = opts.preklad || prekladac();
  const limitPrekladu = opts.limitPrekladu !== undefined ? opts.limitPrekladu : (Number(process.env.INV_PREKLAD_LIMIT) || 300);
  const ted = opts.ted || (() => Date.now());
  const dnesPraha = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date(ted()));
  const posta = opts.posta || vytvorPostu();
  const prahPohybu = (opts.prahPohybu !== undefined ? opts.prahPohybu : Number(process.env.INV_POHYB_PRAH) || 5) / 100;
  const adresaWebu = (opts.adresa !== undefined ? opts.adresa : process.env.INV_ADRESA || '').replace(/\/+$/, '');
  const odkaz = (zalozka) => (adresaWebu ? adresaWebu + '/#' + zalozka : 'záložka ' + zalozka + ' na webu');
  fs.mkdirSync(dataDir, { recursive: true });

  const klicSoubor = path.join(dataDir, 'cookie.key');
  let klic;
  try { klic = fs.readFileSync(klicSoubor); } catch (e) { klic = null; }
  if (!klic || klic.length < 32) { klic = crypto.randomBytes(32); fs.writeFileSync(klicSoubor, klic, { mode: 0o600 }); }

  // Stránka je stejný soubor, který se publikuje jako artifact (bez <html>/<head>); server ji obalí.
  const zdroj = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace(/^\s*<title>[^<]*<\/title>\s*/, '')
    .replace(/<meta name="claude:viewport-fit-sides"[^>]*>\s*/, '');
  const pokynPrekladu = vytahniPokyn(zdroj);
  const stranka = HLAVA(TITUL) + '<script>window.__INV_SERVER=1</script>' + zdroj + '</body></html>';

  const denikSoubor = path.join(dataDir, 'denik.json');
  let obchody = [];
  let denikOk = true;
  try {
    const j = JSON.parse(fs.readFileSync(denikSoubor, 'utf8'));
    if (!Array.isArray(j.trades)) throw new Error('chybí pole trades');
    obchody = j.trades;
  } catch (e) {
    // Chybějící soubor = prázdný deník. Nečitelný soubor se nepřepíše: zápisy se odmítnou, dokud ho někdo neopraví.
    if (e.code !== 'ENOENT') { denikOk = false; console.error('Deník nejde přečíst, zápis je vypnutý:', e.message); }
  }
  let fronta = Promise.resolve();
  function uloz() {
    const text = JSON.stringify({ trades: obchody }, null, 1);
    fronta = fronta.then(() => new Promise((ok, chyba) => {
      const tmp = denikSoubor + '.tmp';
      fs.writeFile(tmp, text, { mode: 0o600 }, (e) => e ? chyba(e) : fs.rename(tmp, denikSoubor, (e2) => e2 ? chyba(e2) : ok()));
    }));
    return fronta;
  }

  // Sledované tituly: ruční seznam, stejné zacházení jako deník (nečitelný soubor se nepřepíše).
  const sledSoubor = path.join(dataDir, 'sledovane.json');
  let sledovane = SLEDOVANE_VYCHOZI.slice();
  let sledOk = true;
  try {
    const j = JSON.parse(fs.readFileSync(sledSoubor, 'utf8'));
    if (!Array.isArray(j.syms)) throw new Error('chybí pole syms');
    sledovane = j.syms.filter(platnySym).slice(0, MAX_SLEDOVANYCH);
    if (!sledovane.includes(BENCHMARK)) sledovane.unshift(BENCHMARK);
  } catch (e) {
    if (e.code !== 'ENOENT') { sledOk = false; console.error('Seznam sledovaných nejde přečíst, změny jsou vypnuté:', e.message); }
  }
  function ulozSledovane() {
    const tmp = sledSoubor + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ syms: sledovane }), { mode: 0o600 });
    fs.renameSync(tmp, sledSoubor);
  }

  // Sledované zdroje (weby, kanály, stránky na sociálních sítích): ruční evidence jako seznam titulů.
  const zdrSoubor = path.join(dataDir, 'zdroje.json');
  let seznamZdroju = ZDROJE_VYCHOZI.map((z) => Object.assign({}, z));
  let zdrOk = true;
  try {
    const j = JSON.parse(fs.readFileSync(zdrSoubor, 'utf8'));
    if (!Array.isArray(j.zdroje)) throw new Error('chybí pole zdroje');
    seznamZdroju = j.zdroje.filter((z) => z && typeof z.id === 'string' && platnaAdresa(z.url)).slice(0, MAX_ZDROJU);
  } catch (e) {
    if (e.code !== 'ENOENT') { zdrOk = false; console.error('Seznam zdrojů nejde přečíst, změny jsou vypnuté:', e.message); }
  }
  function ulozZdroje() {
    const tmp = zdrSoubor + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ zdroje: seznamZdroju }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, zdrSoubor);
  }

  // Překladač: počet překladů v měsíci (brzda útraty) a posledních pár výsledků pro přehled.
  const prekSoubor = path.join(dataDir, 'preklady.json');
  let prek = { mesic: '', pocet: 0, posledni: [] };
  try {
    const j = JSON.parse(fs.readFileSync(prekSoubor, 'utf8'));
    if (j && typeof j.pocet === 'number' && Array.isArray(j.posledni)) prek = { mesic: String(j.mesic || ''), pocet: j.pocet, posledni: j.posledni.slice(0, 20) };
  } catch (e) { /* první spuštění nebo nečitelný soubor: počítá se od nuly, historie překladů není ruční evidence */ }
  function ulozPreklady() {
    const tmp = prekSoubor + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(prek), { mode: 0o600 });
    fs.renameSync(tmp, prekSoubor);
  }
  const zbyvaPrekladu = () => { const m = dnesPraha().slice(0, 7); if (prek.mesic !== m) { prek.mesic = m; prek.pocet = 0; } return Math.max(0, limitPrekladu - prek.pocet); };

  const cerstvy = (k) => k && !k.stare && k.cas > 0 && ted() / 1000 - k.cas <= CERSTVY_KURZ;
  const kurzNeboNic = (sym) => trh.kurz(sym).catch(() => null);

  // Zkušební obchod se uzavře za skutečný kurz v okamžiku kontroly – po skoku ceny přes noc tedy i hůř než na stopu.
  async function uzavri(i, k, duvod) {
    const b = obchody[i].bSym ? await kurzNeboNic(obchody[i].bSym) : null;
    obchody[i] = Object.assign({}, obchody[i], { exit: k.cena, xd: dnesPraha(), autoClose: duvod, bExit: b ? b.cena : null });
  }
  // ---- Upozornění e-mailem a zálohy ----
  // Stav, aby se totéž neposlalo dvakrát ani po restartu: který den už šlo upozornění na pohyb titulu a kdy týdenní záloha.
  const upoSoubor = path.join(dataDir, 'upozorneni.json');
  let upo = { pohyby: {}, zalohaMail: '' };
  try { const j = JSON.parse(fs.readFileSync(upoSoubor, 'utf8')); if (j && typeof j.pohyby === 'object') upo = { pohyby: j.pohyby || {}, zalohaMail: String(j.zalohaMail || '') }; } catch (e) { /* první spuštění */ }
  function ulozUpo() { const tmp = upoSoubor + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(upo), { mode: 0o600 }); fs.renameSync(tmp, upoSoubor); }

  // Pošta nesmí shodit hlídání ani požadavek: chyba se zapíše do logu a vrátí se false.
  async function oznam(predmet, text, prilohy) {
    if (!posta.zapnuto()) return false;
    try { await posta.posli({ predmet: 'Investiční škola: ' + predmet, text, prilohy }); return true; }
    catch (e) { console.error('E-mail se nepodařilo odeslat:', e.kod || '', e.message); return false; }
  }

  function textUzavreni(o) {
    const pct = o.exit / o.entry - 1, kc = o.size * pct - (o.fees || 0);
    const jak = { stop: 'skončil na stopu', cil: 'došel na cíl' }[o.autoClose] || 'byl uzavřen';
    const radky = [
      `Zkušební obchod ${o.t} (${o.sym}) ${jak}.`, '',
      `Výsledek: ${seZnamenkem(Math.round(kc), 0, 'Kč')} (${seZnamenkem(pct * 100, 1, '%')}) z pozice ${cz(o.size)} Kč`,
      `Nákup: ${cz(o.entry, 2)} ${o.cur || ''} dne ${o.d}`,
      `Prodej: ${cz(o.exit, 2)} ${o.cur || ''} dne ${o.xd}`,
      `Plán: stop ${cz(o.stop, 2)}, cíl ${cz(o.target, 2)}`,
    ];
    if (o.autoClose === 'stop' && o.exit < o.stop * 0.999) radky.push(`Cena stop přeskočila: prodáno o ${cz((1 - o.exit / o.stop) * 100, 1)} % níž, než byl plán. Tak to chodí i se skutečnými penězi.`);
    if (o.bEntry > 0 && o.bExit > 0) { const e = o.bExit / o.bEntry - 1; radky.push(`Stejné peníze v ETF za stejnou dobu: ${seZnamenkem(e * 100, 1, '%')} (${seZnamenkem(Math.round(o.size * e), 0, 'Kč')})`); }
    radky.push('', `Proč jsi kupoval: ${o.why || ''}`, '', `Zapiš si do deníku, co sis z obchodu odnesl: ${odkaz('obchod')}`);
    return { predmet: `${o.t} ${jak}, ${seZnamenkem(Math.round(kc), 0, 'Kč')}`, text: radky.join('\n') };
  }

  // Velký denní pohyb sledovaného titulu: jedno upozornění na titul a obchodní den.
  async function zkontrolujPohyby() {
    if (!posta.zapnuto()) return 0;
    let poslano = 0;
    for (const sym of sledovane) {
      const k = await kurzNeboNic(sym);
      if (!cerstvy(k) || k.zmena == null || Math.abs(k.zmena) < prahPohybu) continue;
      const den = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date(k.cas * 1000));
      if (upo.pohyby[sym] === den) continue;
      const moje = obchody.filter((o) => o.auto && o.sym === sym && o.exit == null);
      const text = [
        `${k.nazev} (${sym}) je dnes ${seZnamenkem(k.zmena * 100, 1, '%')} proti včerejšímu závěru.`, '',
        `Kurz: ${cz(k.cena, 2)} ${k.mena}, včera ${cz(k.predchozi, 2)} ${k.mena}`,
        ...moje.map((o) => `Máš v ní otevřenou zkušební pozici ${cz(o.size)} Kč: nákup ${cz(o.entry, 2)}, stop ${cz(o.stop, 2)}, cíl ${cz(o.target, 2)}.`),
        '', 'Velký denní pohyb sám o sobě neznamená, že je potřeba něco dělat. Podívej se, co se stalo, a když tomu nerozumíš, vlož zprávu do Překladače.',
        '', `Graf: ${odkaz('trh')}`,
      ].join('\n');
      upo.pohyby[sym] = den; ulozUpo(); // zapsat předem: při chybě pošty se nemá každou kontrolu zkoušet znovu
      if (await oznam(`${k.nazev} dnes ${seZnamenkem(k.zmena * 100, 1, '%')}`, text)) poslano++;
    }
    return poslano;
  }

  // Záloha: všechno, co uživatel zadal ručně a nejde odjinud obnovit.
  const zalohaDat = () => ({ vytvoreno: new Date(ted()).toISOString(), verze, denik: { trades: obchody }, sledovane, zdroje: seznamZdroju });
  const zalohyDir = path.join(dataDir, 'zalohy');
  const snimky = () => { try { return fs.readdirSync(zalohyDir).filter((f) => /^denik-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch (e) { return []; } };
  // Denní snímek do složky dat (60 posledních). Chrání před omylem a chybou programu; před ztrátou serveru chrání
  // kopie mimo kontejner (deploy/nasadit.sh) a týdenní e-mail.
  function ulozSnimek() {
    if (!denikOk) return false;
    const soubor = path.join(zalohyDir, 'denik-' + dnesPraha() + '.json');
    if (fs.existsSync(soubor)) return false;
    fs.mkdirSync(zalohyDir, { recursive: true });
    fs.writeFileSync(soubor, JSON.stringify(zalohaDat()), { mode: 0o600 });
    for (const stary of snimky().slice(0, -SNIMKU)) fs.unlinkSync(path.join(zalohyDir, stary));
    return true;
  }
  // Týdenní záloha e-mailem: v neděli po 18. hodině pražského času, jednou. Kopie tak existuje i mimo server.
  let zalohaPokus = 0;
  async function tydenniZaloha() {
    if (!posta.zapnuto() || !denikOk) return false;
    const casti = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(ted()));
    const den = casti.find((c) => c.type === 'weekday').value, hodina = Number(casti.find((c) => c.type === 'hour').value);
    const dnes = dnesPraha();
    if (den !== 'Sun' || hodina < 18 || upo.zalohaMail === dnes) return false;
    if (ted() - zalohaPokus < 3600 * 1000) return false; // po neúspěchu další pokus až za hodinu
    zalohaPokus = ted();
    const uzavrene = obchody.filter((o) => o.exit != null), otevrene = obchody.length - uzavrene.length;
    const text = [
      'V příloze je záloha deníku obchodů, sledovaných titulů a zdrojů. Schovej si ji; kdyby se se serverem něco stalo, deník z ní jde obnovit.', '',
      `V deníku je ${obchody.length} obchodů (${uzavrene.length} uzavřených, ${otevrene} otevřených), sleduješ ${sledovane.length} titulů a ${seznamZdroju.length} zdrojů.`,
      '', `Deník: ${odkaz('obchod')}`,
    ].join('\n');
    const ok = await oznam('týdenní záloha deníku', text, [{ nazev: `investicni-skola-zaloha-${dnes}.json`, obsah: JSON.stringify(zalohaDat(), null, 1) }]);
    if (ok) { upo.zalohaMail = dnes; ulozUpo(); }
    return ok;
  }

  let hlidaBezi = false;
  async function zkontrolujObchody() {
    if (hlidaBezi || !denikOk) return 0;
    hlidaBezi = true;
    let zmen = 0;
    const uzavrene = [];
    try {
      const otevrene = obchody.filter((o) => o.auto && o.sym && o.exit == null);
      for (const sym of new Set(otevrene.map((o) => o.sym))) {
        const k = await kurzNeboNic(sym);
        if (!cerstvy(k)) continue;
        for (const o of otevrene.filter((x) => x.sym === sym)) {
          if (k.cas * 1000 <= Date.parse(o.created)) continue; // kurz starší než nákup nic neříká
          const duvod = k.cena <= o.stop ? 'stop' : k.cena >= o.target ? 'cil' : null;
          const i = obchody.findIndex((x) => x.id === o.id);
          if (duvod && i >= 0 && obchody[i].exit == null) { await uzavri(i, k, duvod); zmen++; uzavrene.push(obchody[i]); }
        }
      }
      if (zmen) await uloz();
      for (const o of uzavrene) { const z = textUzavreni(o); await oznam(z.predmet, z.text); }
    } catch (e) { console.error('Hlídání stopu a cíle selhalo:', e.message); }
    hlidaBezi = false;
    return zmen;
  }
  // Co se děje každou minutu: stop a cíl; jednou za pět minut velké pohyby; jednou denně snímek; v neděli záloha mailem.
  let minut = 0;
  async function minutovaKontrola() {
    await zkontrolujObchody();
    try {
      if (minut++ % 5 === 0) await zkontrolujPohyby();
      ulozSnimek();
      await tydenniZaloha();
    } catch (e) { console.error('Pravidelná kontrola selhala:', e.message); }
  }

  const pokusy = new Map();
  function adresa(req) {
    if (trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
    return req.socket.remoteAddress || '';
  }
  function zabrzdeno(ip) {
    const t = Date.now(), p = pokusy.get(ip);
    if (!p || t - p.od > POKUSY_OKNO) return false;
    return p.n >= POKUSY_MAX;
  }
  function zapisPokus(ip) {
    const t = Date.now(), p = pokusy.get(ip);
    if (!p || t - p.od > POKUSY_OKNO) pokusy.set(ip, { od: t, n: 1 }); else p.n++;
    if (pokusy.size > 5000) for (const [k, v] of pokusy) if (t - v.od > POKUSY_OKNO) pokusy.delete(k);
  }

  const podpis = (s) => crypto.createHmac('sha256', klic).update(s).digest('base64url');
  function novaCookie() { const exp = String(Date.now() + PLATNOST); return exp + '.' + podpis(exp); }
  function prihlasen(req) {
    const m = /(?:^|;\s*)inv_s=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    const [exp, sig] = m[1].split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig), b = Buffer.from(podpis(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function cookieHlavicka(req, hodnota, maxAge) {
    const https = trustProxy || req.socket.encrypted;
    return `inv_s=${hodnota}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
  }

  const BEZP = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  function posli(res, kod, typ, telo, extra) {
    res.writeHead(kod, Object.assign({ 'Content-Type': typ }, BEZP, extra || {}));
    res.end(telo);
  }
  const json = (res, kod, obj, extra) => posli(res, kod, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
  const presmeruj = (res, kam, extra) => { res.writeHead(303, Object.assign({ Location: kam }, BEZP, extra || {})); res.end(); };

  function telo(req, max = MAX_TELO) {
    return new Promise((ok, chyba) => {
      let n = 0; const casti = [];
      req.on('data', (c) => { n += c.length; if (n > max) { chyba(Object.assign(new Error('moc velké'), { kod: 413 })); req.destroy(); } else casti.push(c); });
      req.on('end', () => ok(Buffer.concat(casti).toString('utf8')));
      req.on('error', chyba);
    });
  }

  function loginStranka(hlaska) {
    return HLAVA('Přihlášení – ' + TITUL) + `<style>
:root{--bg:#F2F4F8;--s:#fff;--ink:#131C33;--ink2:#46516B;--line:#D9DEE8;--acc:#2747D4;--on:#fff;--loss:#D1442F}
@media (prefers-color-scheme:dark){:root{--bg:#0F1422;--s:#182033;--ink:#E9ECF5;--ink2:#B6BED3;--line:#2B3550;--acc:#8FA6FF;--on:#0F1422;--loss:#DB5A45;color-scheme:dark}}
body{background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}
form{background:var(--s);border:1px solid var(--line);border-radius:10px;padding:24px;display:grid;gap:14px;width:100%;max-width:340px;box-sizing:border-box}
h1{font-size:1.25rem;margin:0}p{margin:0;color:var(--ink2);font-size:.92rem}.err{color:var(--loss)}
label{display:grid;gap:4px;font-size:.86rem;color:var(--ink2)}
input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
button{font:600 1rem system-ui,sans-serif;padding:10px;border:0;border-radius:8px;background:var(--acc);color:var(--on);cursor:pointer}
input:focus-visible,button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
</style><form method="post" action="/login"><h1>${TITUL}</h1><p>Investiční škola. Přihlas se heslem.</p>${hlaska ? `<p class="err" role="alert">${hlaska}</p>` : ''}<label>Heslo<input type="password" name="heslo" id="heslo" autocomplete="current-password" required autofocus></label><button type="submit">Přihlásit</button></form></body></html>`;
  }

  function overObchod(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    const cislo = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const o = {
      t: text(b.t, 40), d: text(b.d, 10), mode: b.mode === 'real' ? 'real' : 'paper',
      size: cislo(b.size), entry: cislo(b.entry), stop: cislo(b.stop), target: cislo(b.target),
      fees: cislo(b.fees) || 0, why: text(b.why, 1000),
    };
    if (!o.t || !/^\d{4}-\d{2}-\d{2}$/.test(o.d) || !o.why) return null;
    if (!(o.size > 0) || !(o.entry > 0) || !(o.stop > 0) || !(o.target > 0) || o.fees < 0) return null;
    if (o.stop >= o.entry || o.target <= o.entry) return null;
    return o;
  }

  async function obsluha(req, res) {
    const url = new URL(req.url, 'http://x');
    const cesta = url.pathname;
    const m = req.method;

    if (cesta === '/api/health' && m === 'GET') return json(res, 200, { ok: true, verze, heslo: !!otisk, denik: denikOk });

    if (cesta === '/login') {
      if (m === 'GET') return prihlasen(req) ? presmeruj(res, '/') : posli(res, 200, 'text/html; charset=utf-8', loginStranka(''));
      if (m === 'POST') {
        const ip = adresa(req);
        if (zabrzdeno(ip)) return posli(res, 429, 'text/html; charset=utf-8', loginStranka('Příliš mnoho pokusů. Zkus to znovu za čtvrt hodiny.'));
        let heslo = '';
        try { heslo = new URLSearchParams(await telo(req)).get('heslo') || ''; } catch (e) { return posli(res, 400, 'text/html; charset=utf-8', loginStranka('Požadavek se nepodařilo přečíst.')); }
        if (!otisk) return posli(res, 503, 'text/html; charset=utf-8', loginStranka('Na serveru není nastavené heslo.'));
        if (await overHeslo(heslo, otisk)) return presmeruj(res, '/', { 'Set-Cookie': cookieHlavicka(req, novaCookie(), Math.floor(PLATNOST / 1000)) });
        zapisPokus(ip);
        return posli(res, 401, 'text/html; charset=utf-8', loginStranka('Heslo nesouhlasí.'));
      }
      return posli(res, 405, 'text/plain; charset=utf-8', 'Nepodporovaná metoda');
    }

    if (!prihlasen(req)) {
      if (cesta.startsWith('/api/')) return json(res, 401, { chyba: 'neprihlasen' });
      return presmeruj(res, '/login');
    }

    if (cesta === '/logout' && m === 'POST') return presmeruj(res, '/login', { 'Set-Cookie': cookieHlavicka(req, 'x', 0) });
    if (cesta === '/' && m === 'GET') return posli(res, 200, 'text/html; charset=utf-8', stranka);

    if (cesta === '/api/trades' && m === 'GET') return json(res, 200, { trades: obchody });

    if (cesta === '/api/zaloha' && m === 'GET') {
      return posli(res, 200, 'application/json; charset=utf-8', JSON.stringify(zalohaDat(), null, 1), { 'Content-Disposition': `attachment; filename="investicni-skola-zaloha-${dnesPraha()}.json"` });
    }
    if (cesta === '/api/upozorneni' && m === 'GET') {
      const s = snimky();
      return json(res, 200, { zapnuto: posta.zapnuto(), adresat: posta.zapnuto() ? posta.adresat() : '', prah: Math.round(prahPohybu * 1000) / 10, snimku: s.length, posledniSnimek: s.length ? s[s.length - 1].slice(6, 16) : null, zalohaMail: upo.zalohaMail || null });
    }
    if (cesta === '/api/upozorneni/test' && m === 'POST') {
      if (req.headers['x-inv'] !== '1') return json(res, 403, { chyba: 'chybi_hlavicka' });
      if (!posta.zapnuto()) return json(res, 503, { chyba: 'bez_posty' });
      try {
        await posta.posli({ predmet: 'Investiční škola: zkušební e-mail', text: ['Upozornění z Investiční školy fungují.', '', `Přijde ti e-mail, když zkušební obchod skončí na stopu nebo cíli, když se sledovaný titul za den pohne o ${cz(prahPohybu * 100, 1)} % a víc, a každou neděli večer záloha deníku.`, '', odkaz('obchod')].join('\n') });
      } catch (e) { console.error('Zkušební e-mail selhal:', e.kod || '', e.message); return json(res, 502, { chyba: e.kod || 'posta_selhala' }); }
      return json(res, 200, { ok: true, adresat: posta.adresat() });
    }

    // ---- Trh: kurzy, graf, hledání, sledované tituly, zkušební nákup a prodej za skutečný kurz ----
    const chybaTrhu = (e) => json(res, e.kod === 'neznamy' ? 404 : 502, { chyba: e.kod || 'nedostupne', zprava: e.message });
    if (cesta === '/api/trh' && m === 'GET') {
      const otevrene = obchody.filter((o) => o.auto && o.sym && o.exit == null).map((o) => o.sym);
      const syms = [...new Set([...sledovane, ...otevrene, BENCHMARK])];
      const kurzy = await Promise.all(syms.map((sym) => trh.kurz(sym).then((k) => Object.assign(k, { cerstvy: cerstvy(k) }), (e) => ({ sym, chyba: e.kod || 'nedostupne' }))));
      return json(res, 200, { kurzy, sledovane, benchmark: BENCHMARK, cas: Math.floor(ted() / 1000) });
    }
    if (cesta === '/api/trh/graf' && m === 'GET') {
      const sym = url.searchParams.get('s') || '', r = url.searchParams.get('r') || '1d';
      if (!platnySym(sym) || !ROZSAHY[r]) return json(res, 400, { chyba: 'spatny_dotaz' });
      try { return json(res, 200, await trh.graf(sym, r)); } catch (e) { return chybaTrhu(e); }
    }
    if (cesta === '/api/trh/hledej' && m === 'GET') {
      try { return json(res, 200, { vysledky: await trh.hledej(url.searchParams.get('q') || '') }); } catch (e) { return chybaTrhu(e); }
    }
    if (cesta === '/api/preklad' && m === 'GET') return json(res, 200, { dostupny: preklad.dostupny(), zbyva: zbyvaPrekladu(), limit: limitPrekladu, posledni: prek.posledni });
    if (cesta === '/api/preklad' && m === 'POST') {
      if (req.headers['x-inv'] !== '1') return json(res, 403, { chyba: 'chybi_hlavicka' });
      if (!preklad.dostupny()) return json(res, 503, { chyba: 'bez_klice' });
      let b; try { b = JSON.parse(await telo(req, 4 * MAX_ZNAKU + 2000)); } catch (e) { return json(res, e.kod || 400, { chyba: e.kod === 413 ? 'moc_dlouhe' : 'spatny_json' }); }
      let material = b && typeof b.text === 'string' ? b.text.trim() : '', zdrojAdresa = null;
      if (!material && b && b.url) {
        const u = platnaAdresa(b.url);
        if (!u) return json(res, 400, { chyba: 'neplatna_adresa' });
        if (typZdroje(u.hostname) !== 'web') return json(res, 400, { chyba: 'socialni_sit' });
        try { const s = await ctec.stahni(u.href); material = textZeStranky(s.text); zdrojAdresa = s.adresa; }
        catch (e) { return json(res, 502, { chyba: e.kod === 'zakazana_adresa' ? 'neplatna_adresa' : 'stranka_nedostupna' }); }
        if (material.length < 80) return json(res, 422, { chyba: 'stranka_bez_textu' });
      }
      if (!material) return json(res, 400, { chyba: 'prazdne' });
      if (material.length > MAX_ZNAKU) return json(res, 413, { chyba: 'moc_dlouhe', znaku: material.length, max: MAX_ZNAKU });
      if (zbyvaPrekladu() <= 0) return json(res, 429, { chyba: 'limit_vycerpan', limit: limitPrekladu });
      // Kontext, aby šla tvrzení o cenách porovnat se skutečností: dnešní datum a kurzy, které server zná.
      const kurzy = (await Promise.all([...new Set([...sledovane, 'BTC-USD'])].map(kurzNeboNic))).filter((k) => k && k.cena != null);
      const kontext = 'Dnes je ' + dnesPraha() + '.' + (kurzy.length ? '\nKurzy, které má server k dispozici (mohou být až čtvrt hodiny zpožděné):\n' + kurzy.map((k) => `- ${k.nazev} (${k.sym}): ${k.cena} ${k.mena}, změna proti předchozímu dni ${k.zmena != null ? (k.zmena * 100).toFixed(1) + ' %' : 'neznámá'}, roční minimum ${k.rokMin ?? '?'}, roční maximum ${k.rokMax ?? '?'}`).join('\n') : '');
      prek.pocet++; // počítá se i neúspěšný pokus, který došel až k modelu – i ten stojí peníze
      let vystup;
      try { vystup = await preklad.preloz({ pokyn: pokynPrekladu, material, zdroj: zdrojAdresa, kontext }); }
      catch (e) {
        ulozPreklady();
        const kody = { odmitnuto: 422, necitelna_odpoved: 502, pretizeno: 503, spatny_klic: 503, nedostupne: 502, moc_dlouhe: 413, bez_klice: 503 };
        if (!kody[e.kod]) console.error('Překlad selhal:', e.message);
        return json(res, kody[e.kod] || 500, { chyba: e.kod || 'chyba_serveru' });
      }
      const zaznam = { kdy: new Date().toISOString(), zdroj: zdrojAdresa || material.replace(/\s+/g, ' ').slice(0, 90), vysledek: vystup.vysledek };
      prek.posledni.unshift(zaznam); prek.posledni = prek.posledni.slice(0, 20);
      ulozPreklady();
      return json(res, 200, { vysledek: vystup.vysledek, zdroj: zdrojAdresa, zbyva: zbyvaPrekladu() });
    }

    if (cesta === '/api/zdroje' && m === 'GET') {
      const vypis = await Promise.all(seznamZdroju.map(async (z) => {
        if (!z.feed) return Object.assign({}, z, { novinky: null });
        try { return Object.assign({}, z, { novinky: await ctec.novinky(z.feed) }); }
        catch (e) { return Object.assign({}, z, { novinky: null, chyba: 'novinky_nedostupne' }); }
      }));
      return json(res, 200, { zdroje: vypis });
    }
    if (cesta.startsWith('/api/zdroje') && (m === 'POST' || m === 'DELETE')) {
      if (req.headers['x-inv'] !== '1') return json(res, 403, { chyba: 'chybi_hlavicka' });
      if (!zdrOk) return json(res, 503, { chyba: 'seznam_necitelny' });
      if (m === 'POST' && cesta === '/api/zdroje') {
        let b; try { b = JSON.parse(await telo(req)); } catch (e) { return json(res, e.kod || 400, { chyba: 'spatny_json' }); }
        const u = platnaAdresa(b && b.url);
        const nazev = b && typeof b.nazev === 'string' ? b.nazev.trim().slice(0, 80) : '';
        const pozn = b && typeof b.pozn === 'string' ? b.pozn.trim().slice(0, 600) : '';
        if (!u) return json(res, 400, { chyba: 'neplatna_adresa' });
        if (!nazev || !pozn) return json(res, 400, { chyba: 'chybi_popis' });
        if (seznamZdroju.some((z) => z.url === u.href)) return json(res, 409, { chyba: 'uz_je' });
        if (seznamZdroju.length >= MAX_ZDROJU) return json(res, 409, { chyba: 'seznam_plny' });
        let info;
        try { info = await ctec.prozkoumej(u.href); } catch (e) { return json(res, 400, { chyba: e.kod || 'neplatna_adresa', zprava: e.message }); }
        const z = { id: crypto.randomBytes(8).toString('hex'), nazev, url: u.href, typ: info.typ || typZdroje(u.hostname), feed: info.feed || null, pozn, pridano: dnesPraha() };
        seznamZdroju.push(z); ulozZdroje();
        return json(res, 201, { zdroj: z });
      }
      if (m === 'DELETE') {
        const id = cesta.slice('/api/zdroje/'.length), i = seznamZdroju.findIndex((z) => z.id === id);
        if (i < 0) return json(res, 404, { chyba: 'nenalezeno' });
        seznamZdroju.splice(i, 1); ulozZdroje();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { chyba: 'nenalezeno' });
    }

    const zmenaTrhu = cesta.startsWith('/api/trh/') && (m === 'POST' || m === 'DELETE');
    const prodej = m === 'POST' && /^\/api\/trades\/[0-9a-f]{16}\/prodat$/.test(cesta);
    if (zmenaTrhu || prodej) {
      if (req.headers['x-inv'] !== '1') return json(res, 403, { chyba: 'chybi_hlavicka' });
      if (cesta.startsWith('/api/trh/sledovane')) {
        if (!sledOk) return json(res, 503, { chyba: 'seznam_necitelny' });
        if (m === 'POST' && cesta === '/api/trh/sledovane') {
          let b; try { b = JSON.parse(await telo(req)); } catch (e) { return json(res, e.kod || 400, { chyba: 'spatny_json' }); }
          const sym = b && typeof b.sym === 'string' ? b.sym.trim().toUpperCase() : '';
          if (!platnySym(sym)) return json(res, 400, { chyba: 'neplatny_titul' });
          if (sledovane.includes(sym)) return json(res, 200, { sledovane });
          if (sledovane.length >= MAX_SLEDOVANYCH) return json(res, 409, { chyba: 'seznam_plny' });
          try { await trh.kurz(sym); } catch (e) { return chybaTrhu(e); } // titul bez kurzu se do seznamu nedostane
          sledovane.push(sym); ulozSledovane();
          return json(res, 201, { sledovane });
        }
        if (m === 'DELETE') {
          const sym = decodeURIComponent(cesta.slice('/api/trh/sledovane/'.length));
          if (sym === BENCHMARK) return json(res, 409, { chyba: 'benchmark_zustava' });
          if (!sledovane.includes(sym)) return json(res, 404, { chyba: 'nenalezeno' });
          sledovane = sledovane.filter((x) => x !== sym); ulozSledovane();
          return json(res, 200, { sledovane });
        }
      }
      if (!denikOk) return json(res, 503, { chyba: 'denik_necitelny' });
      if (m === 'POST' && cesta === '/api/trh/koupit') {
        let b; try { b = JSON.parse(await telo(req)); } catch (e) { return json(res, e.kod || 400, { chyba: 'spatny_json' }); }
        const cislo = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);
        const sym = b && typeof b.sym === 'string' ? b.sym : '', size = cislo(b && b.size), sp = cislo(b && b.stopPct), tp = cislo(b && b.targetPct);
        const why = b && typeof b.why === 'string' ? b.why.trim().slice(0, 1000) : '';
        if (!platnySym(sym) || !(size > 0 && size <= 1e7) || !(sp > 0 && sp < 90) || !(tp > 0 && tp <= 1000) || !why) return json(res, 400, { chyba: 'neplatny_obchod' });
        if (obchody.length >= MAX_OBCHODU) return json(res, 409, { chyba: 'denik_plny' });
        let k; try { k = await trh.kurz(sym); } catch (e) { return chybaTrhu(e); }
        if (!cerstvy(k)) return json(res, 409, { chyba: 'trh_zavreny', cas: k.cas });
        const bk = sym === BENCHMARK ? k : await kurzNeboNic(BENCHMARK);
        const zaokr = (x) => Math.round(x * 10000) / 10000;
        const o = {
          t: String(k.nazev).slice(0, 40), sym, cur: k.mena, d: dnesPraha(), mode: 'paper', size,
          entry: k.cena, stop: zaokr(k.cena * (1 - sp / 100)), target: zaokr(k.cena * (1 + tp / 100)), fees: 0, why,
          auto: true, bSym: BENCHMARK, bEntry: bk ? bk.cena : null,
          id: crypto.randomBytes(8).toString('hex'), exit: null, created: new Date().toISOString(),
        };
        obchody.push(o); await uloz();
        return json(res, 201, { trade: o });
      }
      if (prodej) {
        const id = cesta.split('/')[3], i = obchody.findIndex((x) => x.id === id);
        if (i < 0) return json(res, 404, { chyba: 'nenalezeno' });
        if (!obchody[i].auto || !obchody[i].sym || obchody[i].exit != null) return json(res, 409, { chyba: 'nelze_prodat' });
        let k; try { k = await trh.kurz(obchody[i].sym); } catch (e) { return chybaTrhu(e); }
        if (!cerstvy(k)) return json(res, 409, { chyba: 'trh_zavreny', cas: k.cas });
        await uzavri(i, k, 'rucne'); await uloz();
        return json(res, 200, { trade: obchody[i] });
      }
      return json(res, 404, { chyba: 'nenalezeno' });
    }

    const zapis = m === 'POST' || m === 'PATCH' || m === 'DELETE';
    if (cesta.startsWith('/api/trades') && zapis) {
      // Zápis jen z vlastní stránky: vlastní hlavička neprojde cizím formulářem a cookie je SameSite=Lax.
      if (req.headers['x-inv'] !== '1') return json(res, 403, { chyba: 'chybi_hlavicka' });
      if (!denikOk) return json(res, 503, { chyba: 'denik_necitelny' });
      const id = cesta.slice('/api/trades/'.length);
      if (m === 'POST' && cesta === '/api/trades') {
        let b; try { b = JSON.parse(await telo(req)); } catch (e) { return json(res, e.kod || 400, { chyba: 'spatny_json' }); }
        const o = overObchod(b);
        if (!o) return json(res, 400, { chyba: 'neplatny_obchod' });
        if (obchody.length >= MAX_OBCHODU) return json(res, 409, { chyba: 'denik_plny' });
        o.id = crypto.randomBytes(8).toString('hex'); o.exit = null; o.created = new Date().toISOString();
        obchody.push(o); await uloz();
        return json(res, 201, { trade: o });
      }
      const i = obchody.findIndex((x) => x.id === id);
      if (!/^[0-9a-f]{16}$/.test(id) || i < 0) return json(res, 404, { chyba: 'nenalezeno' });
      if (m === 'PATCH') {
        let b; try { b = JSON.parse(await telo(req)); } catch (e) { return json(res, e.kod || 400, { chyba: 'spatny_json' }); }
        if (!b || typeof b.exit !== 'number' || !(b.exit > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.xd || ''))) return json(res, 400, { chyba: 'neplatne_uzavreni' });
        obchody[i] = Object.assign({}, obchody[i], { exit: b.exit, xd: b.xd, lesson: typeof b.lesson === 'string' ? b.lesson.trim().slice(0, 1000) : '' });
        await uloz();
        return json(res, 200, { trade: obchody[i] });
      }
      if (m === 'DELETE') { obchody.splice(i, 1); await uloz(); return json(res, 200, { ok: true }); }
    }

    return cesta.startsWith('/api/') ? json(res, 404, { chyba: 'nenalezeno' }) : posli(res, 404, 'text/plain; charset=utf-8', 'Nenalezeno');
  }

  const srv = http.createServer((req, res) => {
    obsluha(req, res).catch((e) => {
      console.error(new Date().toISOString(), req.method, req.url, e && e.message);
      if (!res.headersSent) json(res, 500, { chyba: 'chyba_serveru' }); else res.end();
    });
  });
  Object.assign(srv, { zkontrolujObchody, zkontrolujPohyby, ulozSnimek, tydenniZaloha, minutovaKontrola });
  const hlidat = opts.hlidac !== undefined ? opts.hlidac : process.env.INV_HLIDAC !== '0';
  if (hlidat) {
    try { ulozSnimek(); } catch (e) { console.error('Snímek deníku se nepodařilo uložit:', e.message); }
    const casovac = setInterval(minutovaKontrola, 60 * 1000);
    casovac.unref();
    srv.on('close', () => clearInterval(casovac));
  }
  return srv;
}

module.exports = { vytvor, hashHesla, overHeslo, POLE_NOVY };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8095;
  if (!process.env.INV_HESLO_HASH) console.error('Pozor: INV_HESLO_HASH není nastavený, přihlásit se nepůjde.');
  vytvor().listen(port, () => console.log(`Investiční škola běží na portu ${port} (verze ${process.env.APP_VERSION || 'vývoj'})`));
}
