'use strict';
// Feature „pravni“ (SPEC kap. 8 a 11): veřejné právní texty renderované za běhu z legal/*.md.
//   GET /podminky   – Obchodní podmínky (legal/obchodni-podminky.md)
//   GET /soukromi   – Zásady ochrany osobních údajů (legal/zasady-ochrany-osobnich-udaju.md)
//   GET /reklamace  – výřez OP čl. 12 (Závady a reklamace) a 13 (Mimosoudní řešení sporů) + kontakt půjčovny
// Export pro jiné moduly (admin tiskne smlouvu a protokoly, platby doklady):
//   legalParams(tenant, settings)  → slovník hodnot pro VŠECHNY placeholdery všech pěti šablon
//                                    (dvojice PLATEBNI_BRANA/PLATEBNI_BRANA_NAZEV, BANKA/BANKA_NAZEV,
//                                    POJISTENI/POJISTOVNA_NAZEV dostávají stejnou hodnotu; údaje rezervace a
//                                    protokolu mají výchozí prázdné hodnoty – admin je přepíše).
//                                    Podmíněné bloky {{#X}}…{{/X}} šablon řídí booleovské parametry „ano“/„ne“:
//                                    PLATCE_DPH, EVIDENCE_UCETNICTVI (REZIM_EVIDENCE = ucetnictvi), DOKLAD_ZJEDNODUSENY
//                                    (REZIM_DOKLADU = zjednoduseny), ANALYTIKA (je nastaven analytický nástroj),
//                                    ZAPISOVAT_NAROZENI_ADRESU, DRUHY_DOKLAD, GPS_LOKATORY, PREDAVANI_MIMO_EU,
//                                    PODPIS_OBRAZOVKA (PODPIS_ZPUSOB = obrazovka), DOKLAD_CISLO_PLNE (DOKLAD_CISLO_TISK
//                                    = plne), POJISTOVNA_UVEDENA, POPLATEK_NABITI_UCTUJEME, PLATBA_NA_MISTE_POVOLENA,
//                                    DOPLATEK_PREDEM_POVINNY, DRIVEJSI_VRACENI_REFUND; u smlouvy navíc SMLOUVA_NA_MISTE
//                                    (SMLOUVA_REZIM = na-miste), KOLO_JE_EKOLO, KAUCE_HOTOVE, VRACENI_BEZ_NAJEMCE a KOLA
//                                    (pole záznamů { KOLO_PORADI, KOLO_TYP, … } – cyklus přes kola; výchozí „ano“ =
//                                    jeden průchod s hodnotami sloučenými do jedné buňky).
//   renderLegal(docName, params, { only, omitHeadings, legalDir }) → { html, title, headings, missing }
//   LEGAL_DOCS – názvy šablon (bez .md)
// Vstup: tenant (tenant.json), settings (tabulka settings + výchozí z tenant.json). Výstup: stránky v layoutu.
// V demo režimu se pod textem zobrazí šedý box „Demo: tento text je návrh k advokátní kontrole, verze X“.

const fs = require('node:fs');
const path = require('node:path');
const md = require('../render/markdown');
const format = require('../render/format');
const page = require('../render/pages/pravni');

const LEGAL_DIR = path.join(__dirname, '..', '..', 'legal');
const LEGAL_DOCS = Object.freeze(['obchodni-podminky', 'zasady-ochrany-osobnich-udaju', 'smlouva-o-najmu-a-predavaci-protokol', 'zaznam-o-cinnostech-zpracovani', 'zpracovatelska-smlouva']);
/** Odkazy mezi šablonami (.md) → veřejné cesty; ostatní .md odkazy se renderují jen jako text. */
const LINK_MAP = Object.freeze({ 'obchodni-podminky.md': '/podminky', 'zasady-ochrany-osobnich-udaju.md': '/soukromi' });
const GATEWAY_NAMES = Object.freeze({ mock: 'simulační platební brána (demo – žádné peníze se nepřevádějí)', comgate: 'ComGate Payments, a.s.', stripe: 'Stripe Payments Europe, Ltd.' });
const BLANK = '…………'; // údaje rezervace / protokolu, které doplní admin při tisku
const SIGNATURE = '________________________';

const fileCache = new Map();

/** Načte šablonu (cache podle mtime). */
function readTemplate(docName, legalDir = LEGAL_DIR) {
  if (!LEGAL_DOCS.includes(docName)) throw new Error(`Neznámý právní dokument: ${docName}`);
  const file = path.join(legalDir, `${docName}.md`);
  const stat = fs.statSync(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.source;
  const source = fs.readFileSync(file, 'utf8');
  fileCache.set(file, { mtimeMs: stat.mtimeMs, source });
  return source;
}

// ---------------------------------------------------------------------------------------------------------
// Formátovací pomocníci

function hoursText(n) {
  const h = Number(n);
  if (!Number.isFinite(h)) return '';
  return format.plural(h, 'hodina', 'hodiny', 'hodin');
}

/** Dny → čitelná lhůta: 30 → „30 dní“, 90 → „90 dní“, 180 → „6 měsíců“, 365 → „12 měsíců“, 730 → „2 roky“. */
function daysText(n) {
  const d = Number(n);
  if (!Number.isFinite(d)) return '';
  if (d === 365) return format.plural(12, 'měsíc', 'měsíce', 'měsíců');
  if (d % 365 === 0 && d > 365) return format.plural(d / 365, 'rok', 'roky', 'let');
  if (d % 30 === 0 && d >= 180) return format.plural(d / 30, 'měsíc', 'měsíce', 'měsíců');
  return format.plural(d, 'den', 'dny', 'dní');
}

function yearsText(n) {
  const y = Number(n);
  return Number.isFinite(y) ? format.plural(y, 'rok', 'roky', 'let') : '';
}

/** Otevírací doba jako věta: „Po–Pá 9:00–18:00, So–Ne 8:00–19:00“. */
function openingHoursText(openingHours) {
  const rows = format.openingHoursRows(openingHours || {});
  return rows.map((r) => `${r.days} ${r.hours}`).join(', ');
}

/** Veřejný host půjčovny (první nelokální z tenant.hosts). */
function publicHost(tenant) {
  const hosts = tenant.hosts || [];
  return hosts.find((h) => !/^(localhost|127\.0\.0\.1|::1)$/.test(h)) || hosts[0] || 'localhost';
}

function money(minor, fallbackMinor) {
  const n = Number(minor);
  return format.money(Number.isFinite(n) ? n : fallbackMinor);
}

// ---------------------------------------------------------------------------------------------------------
// Slovník parametrů

/**
 * Slovník hodnot pro všechny placeholdery právních šablon z tenant.json (business, legal, openingHours, hosts)
 * a efektivních settings. Volitelné přepisy: tenant.legal.params a settings.legalParams (klíč → hodnota).
 * @param {object} tenant
 * @param {object} [settings]
 */
function legalParams(tenant, settings = {}) {
  const b = tenant.business || {};
  const l = tenant.legal || {};
  const s = settings || {};
  const fee = s.feeMinor || {};
  const dep = s.depositMinor || {};
  const cancellation = s.cancellation || {};
  const vat = !!b.vatPayer;
  const legalName = b.legalName || tenant.name || '';
  const isCompany = /\b(s\.\s?r\.\s?o\.|a\.\s?s\.|spol\.|k\.\s?s\.|v\.\s?o\.\s?s\.|z\.\s?s\.)\s*$/i.test(legalName);
  const host = publicHost(tenant);
  const base = `https://${host}`;
  const email = b.email || '';
  const phone = b.phone || '';
  const gateway = s.gatewayName || GATEWAY_NAMES[s.gateway] || s.gateway || 'platební brána';
  const bank = b.bankName || 'banka půjčovny';
  const insurance = s.insurance || l.insurance || 'kola nejsou pojištěna pro případ škody způsobené nájemcem';
  const processors = Array.isArray(l.processors) ? l.processors : [];
  const operatorEmail = l.operatorEmail || email;
  const storno = md.stornoTable(cancellation);
  const effective = l.effectiveFrom ? format.date(l.effectiveFrom) : BLANK;
  const version = l.version || '1.0';
  const transferHours = Number(s.transferExpiryHours) || 48;
  const yesNo = (v) => (v ? 'ano' : 'ne');
  const accountingMode = s.accountingMode || (isCompany ? 'ucetnictvi' : 'danova-evidence');
  const docMode = 'zjednoduseny';
  const signatureMode = s.signatureMode || 'obrazovka';
  const idDocPrint = s.idDocPrint || 'maskovane';
  const contractMode = s.contractMode || 'online';

  const out = {
    // --- půjčovna (správce) ---
    PUJCOVNA_NAZEV: legalName,
    PUJCOVNA_ICO: b.ico || '',
    PUJCOVNA_DIC: vat ? b.dic || '' : '',
    PUJCOVNA_SIDLO: b.address || '',
    PUJCOVNA_PROVOZOVNA: b.premises || b.address || '',
    PUJCOVNA_REJSTRIK: b.register || (isCompany ? 'zapsaná v obchodním rejstříku' : 'zapsaný v živnostenském rejstříku'),
    PUJCOVNA_EMAIL: email,
    PUJCOVNA_TELEFON: phone,
    PUJCOVNA_ZASTUPCE: b.representative || BLANK,
    PUJCOVNA_INCIDENT_KONTAKT: [email, phone].filter(Boolean).join(', '),
    PUJCOVNA_DPO: b.dpo || '',
    PUJCOVNA_ODPOVEDNA_OSOBA: b.privacyContact || 'majitel / jednatel',
    PUJCOVNA_POCET_OSOB: b.staffCount !== undefined ? String(b.staffCount) : 'méně než 250',
    OTEVIRACI_DOBA: openingHoursText(tenant.openingHours),
    WEB_SUBDOMENA: host,
    DOMENA_MUSTERU: l.platformDomain || host.split('.').slice(-2).join('.'),
    PODMINKY_URL: `${base}/podminky`,
    ZASADY_URL: `${base}/soukromi`,
    CENIK_URL: `${base}/cenik`,
    ODESILACI_ADRESA: l.senderAddress || `rezervace@${host}`,

    // --- provozovatel musteru (zpracovatel) ---
    PROVOZOVATEL_NAZEV: l.operatorName || '',
    PROVOZOVATEL_ICO: l.operatorIco || '',
    PROVOZOVATEL_SIDLO: l.operatorAddress || BLANK,
    PROVOZOVATEL_EMAIL: operatorEmail,
    PROVOZOVATEL_REJSTRIK: l.operatorRegister || BLANK,
    PROVOZOVATEL_ZASTUPCE: l.operatorRepresentative || BLANK,
    PROVOZOVATEL_INCIDENT_KONTAKT: l.operatorIncidentContact || operatorEmail,
    PROVOZOVATEL_DPO: l.operatorDpo || '',
    PROVOZOVATEL_ODPOVEDNA_OSOBA: l.operatorPrivacyContact || BLANK,
    HOSTING_NAZEV: processors[0] || 'Hetzner Online GmbH (hosting, Německo – EU)',
    EMAIL_SLUZBA_NAZEV: processors[1] || 'e-mailová služba (bude doplněna)',
    EMAIL_SLUZBA_SIDLO: l.emailServiceAddress || BLANK,
    EMAIL_SLUZBA_LOKALITA: l.emailServiceLocation || 'EU',
    EMAIL_SLUZBA_ZALOZNI: l.emailServiceBackup || BLANK,
    MONITORING_SLUZBA: l.monitoringService || '',
    DNS_POSKYTOVATEL: l.dnsProvider || 'Hetzner DNS',
    HETZNER_LOKALITA: l.hostingLocation || 'Falkenstein a Norimberk (Německo), zálohy tamtéž; vše EU',
    HLAVNI_SMLOUVA: l.mainContract || 'Smlouva o poskytování webu a rezervačního systému',
    MAPOVE_PODKLADY: l.mapProviders || 'Seznam.cz, a.s. (Mapy.cz) a CyclOSM (OpenStreetMap France)',

    // --- DPH a doklady ---
    PLATCE_DPH: yesNo(vat),
    REZIM_DOKLADU: docMode,
    DOKLAD_ZJEDNODUSENY: yesNo(docMode === 'zjednoduseny'),
    REZIM_EVIDENCE: accountingMode,
    EVIDENCE_UCETNICTVI: yesNo(accountingMode === 'ucetnictvi'),
    STORNO_DPH_REZIM: s.stornoVatMode || 'zdanitelne-plneni',
    DOBA_DOKLADY: vat ? '10 let od konce zdaňovacího období, ve kterém se plnění uskutečnilo (§ 35 odst. 2 ZDPH)' : '5 let od konce účetního období',

    // --- platby, brána, banka ---
    PLATEBNI_BRANA_NAZEV: gateway,
    PLATEBNI_BRANA: gateway,
    BANKA_NAZEV: bank,
    BANKA: bank,
    BANKOVNI_UCET: [b.accountNumber, b.iban ? `IBAN ${b.iban}` : null].filter(Boolean).join(', '),
    TERMINAL_POSKYTOVATEL: s.terminalProvider || '',
    UCETNI_NAZEV: s.accountantName || '',
    UCETNI_ROLE: s.accountantRole || 'zpracovatel',
    POJISTENI: insurance,
    POJISTOVNA_NAZEV: insurance,
    POJISTOVNA_UVEDENA: yesNo(s.insurance || l.insurance), // půjčovna uvedla pojišťovnu → bloky o pojišťovně
    POPLATEK_KOLO: money(fee.default, 30000),
    POPLATEK_EKOLO: money(fee.ebike ?? fee.default, 50000),
    KAUCE_KOLO: money(dep.default, 300000),
    KAUCE_EKOLO: money(dep.ebike, 1000000),
    PREAUTH_MAX_DNU: String(s.preauthMaxDays ?? 7),
    LHUTA_PLATBY_POPLATKU: `${hoursText(transferHours)} od odeslání rezervace; začíná-li nájem dříve než za ${hoursText(transferHours)}, do 20:00 dne předcházejícího začátku nájmu`,
    PLATBA_NA_MISTE_POVOLENA: yesNo(s.allowPayOnSite),
    DOPLATEK_PREDEM_POVINNY: yesNo(s.balanceBeforePickup),
    TOLERANCE_PLATBY: money(s.paymentToleranceMinor, 500),

    // --- storno ---
    STORNO_TABULKA: storno,
    STORNO_LHUTA_HODIN: String(storno.hours),
    ZMENA_TERMINU_LHUTA: hoursText(s.changeHoursBefore ?? 24),
    NO_SHOW_LHUTA: s.noShowText || '2 hodiny, nejdéle do konce otevírací doby téhož dne',
    STORNO_POCASI: s.weatherPolicy || 'Zvláštní pravidlo pro počasí neuplatňujeme.',
    LHUTA_VRATKY: daysText(s.refundDays ?? 14),

    // --- doklad totožnosti ---
    DOKLAD_REZIM: 'A',
    DOKLADY_AKCEPTOVANE: s.acceptedIdDocs || 'občanský průkaz, cestovní pas nebo řidičský průkaz',
    DOBA_CISLO_DOKLADU: daysText(s.idDocRetentionDays ?? 30),
    DRUHY_DOKLAD: yesNo(s.secondIdDoc),
    ZAPISOVAT_NAROZENI_ADRESU: yesNo(s.recordBirthAddress),
    DOKLAD_CISLO_TISK: idDocPrint,
    DOKLAD_CISLO_PLNE: yesNo(idDocPrint === 'plne'),
    PODPIS_ZPUSOB: signatureMode,
    PODPIS_OBRAZOVKA: yesNo(signatureMode === 'obrazovka'),
    OBSLUHA_JMENO_FORMAT: s.staffNameFormat || 'jmeno_a_iniciala',

    // --- užívání, vrácení, škody ---
    DEFINICE_DNE: s.dayDefinition || 'doba od převzetí kola do stejného času následujícího dne, nejpozději však do konce otevírací doby toho dne; hodinová sazba se účtuje do 4 hodin, půlden je nejvýše 6 hodin od převzetí',
    PRILBA_PODMINKY: s.helmetPolicy || 'zdarma k zapůjčení na vyžádání (v rámci dostupných velikostí)',
    UZEMI_UZIVANI: s.usageTerritory || 'území České republiky',
    CENIK_NAHRAD: s.replacementPriceList || '',
    SPOLUUCAST_KRADEZ: s.theftDeductible || 'Omezení náhrady při krádeži neuplatňujeme.',
    TOLERANCE_POZDNI: format.plural(s.lateToleranceMinutes ?? 30, 'minuta', 'minuty', 'minut'),
    SAZBA_POZDNI: s.lateRate || 'hodinová sazba podle ceníku za každou započatou hodinu, nejvýše denní sazba za každý započatý den',
    POPLATEK_POZDNI_PAUSAL: money(s.lateReturnFlatMinor, 30000),
    POPLATEK_CISTENI: money(s.cleaningFlatMinor, 30000),
    POPLATEK_NABITI: money(s.chargingFlatMinor, 0),
    POPLATEK_NABITI_UCTUJEME: yesNo(Number(s.chargingFlatMinor) > 0),
    DRIVEJSI_VRACENI_REFUND: yesNo(s.earlyReturnRefund),
    LHUTA_VYUCTOVANI_SKODY: '14 dnů od vrácení',
    LHUTA_UHRADY_SKODY: '14 dnů od doručení vyúčtování',
    LHUTA_VRATKY_KAUCE_PREVODEM: '5 pracovních dnů',

    // --- lhůty uchování ---
    DOBA_NEDOKONCENE_REZERVACE: daysText(s.reservationRetentionDays ?? 90),
    DOBA_SMLOUVA: yearsText(s.contractRetentionYears ?? 3),
    DOBA_LOGY: daysText(s.logRetentionDays ?? 365),
    DOBA_ZALOHY: daysText(s.backupRetentionDays ?? 365),
    DOBA_KOMUNIKACE: '1 rok od posledního kontaktu',
    DOBA_MARKETING: '3 roky od poslední výpůjčky',
    MARKETING_FREKVENCE: 'nejvýše 4× ročně',
    DOBA_NESPAROVANE_POHYBY: '12 měsíců od zaúčtování',
    DOBA_FRONTY: '90 dní',

    // --- analytika, předávání mimo EU, GPS ---
    ANALYTIKA: yesNo(s.analyticsTool), // zapnutý analytický nástroj s cookies → bloky o cookie liště
    ANALYTIKA_NASTROJ: s.analyticsTool || '',
    ANALYTIKA_POSKYTOVATEL: s.analyticsProvider || '',
    ANALYTIKA_COOKIES_TABULKA: s.analyticsCookiesTable || '',
    PREDAVANI_MIMO_EU: yesNo(s.transferOutsideEu),
    PREDAVANI_MIMO_EU_POPIS: s.transferOutsideEuText || '',
    GPS_LOKATORY: yesNo(s.gpsTrackers),

    // --- lhůty zpracovatelské smlouvy ---
    LHUTA_OHLASENI_INCIDENTU: '24 hodin',
    LHUTA_PREDANI_ZADOSTI: '3 pracovní dny',
    LHUTA_SOUCINNOSTI: '10 pracovních dnů',
    LHUTA_OZNAMENI_PODZPRACOVATELE: '30 dnů',
    LHUTA_NAMITKY: '14 dnů',
    LHUTA_OZNAMENI_ZMENY_SMLOUVY: '30 dnů',
    LHUTA_EXPORTU: '30 dnů',
    LHUTA_VYMAZU: '14 dnů',
    LHUTA_VYMAZU_ZALOH: '30 dnů',
    FREKVENCE_TESTU_OBNOVY: 'měsíčně',
    VYPOVEDNI_DOBA_ZMENA: '3 měsíce',
    LHUTA_OZNAMENI_AUDITU: '14 dnů',
    SAZBA_SOUCINNOSTI: l.supportRate || `${BLANK} Kč/hod. bez DPH`,
    LIMIT_ODPOVEDNOSTI: l.liabilityCap || 'částka rovná odměně zaplacené za posledních 12 měsíců',

    // --- verze a data ---
    VERZE: version,
    UCINNOST_OD: effective,
    OP_VERZE: version,
    ZASADY_VERZE: version,
    DATUM_REVIZE: effective,
    DATUM_UZAVRENI: BLANK,
    SMLOUVA_ZPRACOVANI_DATUM: BLANK,
    SEZNAM_SPRAVCU: '(řádky generuje platforma)',

    // --- rezervace a protokol (doplní admin při tisku smlouvy / protokolu) ---
    SMLOUVA_REZIM: contractMode, // 'online' (rezervace přes web) | 'na-miste' (založila obsluha na výdejním místě)
    SMLOUVA_NA_MISTE: yesNo(contractMode === 'na-miste'),
    KOLA: 'ano', // pole záznamů { KOLO_PORADI, KOLO_TYP, KOLO_JE_EKOLO, … } → řádky pro každé kolo; „ano“ = jeden průchod
    KAUCE_HOTOVE: 'ne', // kauce složená hotově → věty o účtu pro vratku
    VRACENI_BEZ_NAJEMCE: 'ne', // vrácení bez společné kontroly nebo mimo otevírací dobu → protokol podepisuje jen obsluha
    SMLOUVA_CISLO: BLANK,
    PROTOKOL_VRACENI_CISLO: BLANK,
    KONECNY_DOKLAD_CISLO: BLANK,
    DOKLAD_POPLATEK_CISLO: BLANK,
    REZERVACE_CISLO: BLANK,
    REZERVACE_DATUM: BLANK,
    REZERVACE_POTVRZENI_DATUM: BLANK,
    NAJEM_OD: BLANK,
    NAJEM_DO: BLANK,
    MISTO_VRACENI: b.premises || b.address || '',
    CENA_CELKEM: BLANK,
    POPLATEK_ZAPLACENO: BLANK,
    POPLATEK_ZAPLACENO_DNE: BLANK,
    DOPLATEK: BLANK,
    DOPLATEK_STAV: BLANK,
    K_UHRADE_PRI_PREVZETI: BLANK,
    KAUCE_CELKEM: BLANK,
    NAJEMCE_JMENO: BLANK,
    NAJEMCE_TELEFON: BLANK,
    NAJEMCE_EMAIL: BLANK,
    NAJEMCE_DOKLAD_TYP: BLANK,
    NAJEMCE_DOKLAD_CISLO: BLANK,
    NAJEMCE_DOKLAD_CISLO_TISK: BLANK,
    NAJEMCE_DATUM_NAROZENI: BLANK,
    NAJEMCE_ADRESA: BLANK,
    NAJEMCE_UCET_VRATKA: BLANK,
    POCET_DALSICH_JEZDCU: '0',
    POCET_NEZLETILYCH: '0',
    KOLO_PORADI: '1',
    KOLO_TYP: BLANK,
    KOLO_JE_EKOLO: 'ne',
    KOLO_INVENTARNI_KOD: BLANK,
    KOLO_VELIKOST: BLANK,
    KOLO_VYROBNI_CISLO: BLANK,
    KOLO_HODNOTA: BLANK,
    KOLO_KAUCE: BLANK,
    KOLO_PRISLUSENSTVI: BLANK,
    KOLO_BATERIE_PROCENTA: BLANK,
    KOLO_POSKOZENI_POZNAMKA: 'bez poškození',
    KOLO_FOTO_POCET: '0',
    KAUCE_FORMA: BLANK,
    KAUCE_TERMINAL_REF: BLANK,
    KAUCE_PREAUTH_REF: BLANK,
    KAUCE_PREAUTH_PLATNOST_DO: BLANK,
    PREDANI_CAS: BLANK,
    OBSLUHA_JMENO: BLANK,
    PODPIS_NAJEMCE: SIGNATURE,
    PODPIS_OBSLUHA: SIGNATURE,
    VRACENI_CAS: BLANK,
    VRACENI_OBSLUHA_JMENO: BLANK,
    VRACENI_ZPOZDENI: '0',
    VRACENI_MIMO_OTEVIRACI_DOBU: 'ne',
    VRACENI_BEZ_KONTROLY: 'ne',
    KOLO_VRACENI_STAV: BLANK,
    KOLO_VRACENI_POSKOZENI: BLANK,
    KOLO_VRACENI_FOTO_POCET: '0',
    KOLO_VRACENI_BATERIE_PROCENTA: BLANK,
    KOLO_VRACENI_PRISLUSENSTVI_CHYBI: 'nic',
    NAJEMNE_PRODLENI: format.money(0),
    POKUTA_OTEVIRACI_DOBA: format.money(0),
    CASTKA_CISTENI: format.money(0),
    CASTKA_NABITI: format.money(0),
    SKODA_POPIS: BLANK,
    SKODA_CASTKA: format.money(0),
    SKODA_JE_ODHAD: 'ne',
    NAHRADA_PRISLUSENSTVI: format.money(0),
    VYUCTOVANI_CELKEM: format.money(0),
    KAUCE_POUZITO: format.money(0),
    KAUCE_DRZENO: format.money(0),
    KAUCE_VRACENO: BLANK,
    KAUCE_VRACENO_FORMA: BLANK,
    ZBYVA_DOPLATIT: format.money(0),
    ZBYVA_VRATIT: format.money(0),
    QR_DOPLATEK: '',
    NAMITKY_TEXT: BLANK,
  };
  return Object.assign(out, l.params || {}, s.legalParams || {});
}

// ---------------------------------------------------------------------------------------------------------
// Render

/**
 * Vyrenderuje právní šablonu s parametry.
 * @param {string} docName jeden z LEGAL_DOCS
 * @param {object} params slovník (zpravidla legalParams(tenant, settings) + údaje rezervace)
 * @param {{only?: (RegExp|string)[], omitHeadings?: (RegExp|string)[], legalDir?: string}} [opts]
 * @returns {{html: string, title: string|null, headings: object[], missing: string[]}}
 */
function renderLegal(docName, params, opts = {}) {
  const source = readTemplate(docName, opts.legalDir);
  return md.render(source, params || {}, { only: opts.only, omitHeadings: opts.omitHeadings, linkMap: LINK_MAP });
}

function paramsFor(ctx) {
  return legalParams(ctx.tenant, ctx.settings);
}

function warnMissing(ctx, docName, doc) {
  if (doc.missing.length) ctx.log.warn('Právní text: chybějící parametry', { doc: docName, missing: doc.missing });
}

function renderDocPage(ctx, docName, { title, description, lead }) {
  const params = paramsFor(ctx);
  const doc = renderLegal(docName, params);
  warnMissing(ctx, docName, doc);
  ctx.render(page.legal, { title: doc.title || title, lead, doc, version: params.VERZE, effectiveFrom: params.UCINNOST_OD, demo: !!ctx.config.demo, toc: true }, { title, description, feature: 'pravni' });
}

async function podminky(ctx) {
  renderDocPage(ctx, 'obchodni-podminky', {
    title: 'Obchodní podmínky',
    description: `Obchodní podmínky půjčovny ${ctx.tenant.name}: rezervace, rezervační poplatek, storno, kauce, převzetí s dokladem totožnosti, odpovědnost a reklamace.`,
    lead: 'Podmínky, se kterými souhlasíte při online rezervaci. Platí verze účinná v okamžiku odeslání rezervace.',
  });
}

async function soukromi(ctx) {
  renderDocPage(ctx, 'zasady-ochrany-osobnich-udaju', {
    title: 'Ochrana osobních údajů',
    description: `Zásady ochrany osobních údajů půjčovny ${ctx.tenant.name}: jaké údaje zpracováváme, proč, jak dlouho a jaká máte práva. Informace o cookies.`,
    lead: 'Informace podle čl. 13 GDPR – stručně na úvod a podrobně dál. Web používá jen technicky nezbytné cookies.',
  });
}

async function reklamace(ctx) {
  const params = paramsFor(ctx);
  const doc = renderLegal('obchodni-podminky', params, { only: [/^12\./, /^13\./] });
  warnMissing(ctx, 'obchodni-podminky', doc);
  ctx.render(
    page.legal,
    {
      title: 'Reklamace a řešení sporů',
      lead: `Výňatek z Obchodních podmínek (čl. 12 Závady a reklamace a čl. 13 Mimosoudní řešení sporů), verze ${params.VERZE}. Úplné znění najdete na stránce Obchodní podmínky.`,
      doc,
      version: params.VERZE,
      effectiveFrom: params.UCINNOST_OD,
      demo: !!ctx.config.demo,
      toc: false,
      excerptOf: { label: 'Obchodní podmínky', href: '/podminky' },
      contact: { business: ctx.tenant.business, openingHours: ctx.tenant.openingHours },
    },
    { title: 'Reklamace', description: `Jak reklamovat závadu kola nebo vyúčtování u půjčovny ${ctx.tenant.name} a kde řešit spor mimosoudně (ČOI).`, feature: 'pravni' }
  );
}

module.exports = {
  name: 'pravni',
  routes: [
    ['GET', '/podminky', podminky, { rateLimit: 'public' }],
    ['GET', '/soukromi', soukromi, { rateLimit: 'public' }],
    ['GET', '/reklamace', reklamace, { rateLimit: 'public' }],
  ],
  nav: [],
  css: ['/css/pravni.css'],
  js: [],
  legalParams,
  renderLegal,
  LEGAL_DOCS,
  LINK_MAP,
  LEGAL_DIR,
  BLANK,
  openingHoursText,
};
