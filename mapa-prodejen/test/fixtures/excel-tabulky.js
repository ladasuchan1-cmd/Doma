'use strict';
// Syntetické tabulky ve tvaru, v jakém je Excel vloží do schránky (oddělené tabulátorem): kontingenční tabulky
// s nadpisem a filtry nad sebou, řádky „Celkem“ a „Celkový součet“, dvě tabulky vedle sebe, křížová tabulka
// s roky ve sloupcích, kompaktní forma bez opakovaných popisků. Čísla jsou vymyšlená, součty sedí.
const T = '\t';
const r = (...c) => c.join(T);
const prazdny = (n) => T.repeat(n - 1);
const NBSP = ' ';

// Plochá tabulka Země / Obec / PSČ se čtyřmi veličinami (nadpis obsahuje „PSČ“, ale není to záhlaví).
const PLOCHA = [
  r('Podklad pro mapu – ploché tabulky dle Země / Obce / PSČ (bez mezisoučtů)', '', '', '', '', '', ''),
  r('Plochá tabulka zákazníků dle Země / Obce / PSČ. Nastavte filtry a tabulku zkopírujte do mapy.', '', '', '', '', '', ''),
  prazdny(7),
  r('Skupina', '(Vše)', '', '', '', '', ''),
  r('Aktivní', '(Více položek)', '', '', '', '', ''),
  prazdny(7),
  r('Země (odhad)', 'Obec', 'PSČ', 'Zákazníků', 'Aktivních', 'Objednávek', 'Hodnota obj. (Kč)'),
  r('CZ', 'Praha', '160 00', `1${NBSP}200`, '100', `2${NBSP}000`, `10${NBSP}000${NBSP}000`),
  r('CZ', 'Praha', '(neuvedeno)', '30', '2', '40', '200 000'),
  r('CZ', 'Praha', '1200', '5', '0', '3', '9 000'),
  r('CZ', 'Praha', '151 00', '0', '0', '0', '0'),
  r('CZ', 'Praha Celkem', '', '1 235', '102', '2 043', '10 209 000'),
  r('CZ', 'Brno', '602 00', '800', '40', '900', '3 000 000'),
  r('CZ', 'Brno Celkem', '', '800', '40', '900', '3 000 000'),
  r('CZ', '(neuvedeno)', '(neuvedeno)', '3 000', '700', '9 000', '50 000 000'),
  r('CZ', 'Berlin', '101 15', '2', '0', '1', '500'),
  r('CZ', '<script>alert(1)</script>', '250 88', '1', '1', '2', '7 000'),
  r('CZ Celkem', '', '', '5 038', '843', '11 946', '63 216 500'),
  r('(neuvedeno)', '(neuvedeno)', '(neuvedeno)', '20 000', '0', '10', '50 000'),
  r('SK', 'Bratislava', '851 01', '150', '0', '30', '40 000'),
  r('SK', 'Hrádok', '916 33', '3', '1', '300', '3 000 000'),
  r('AT', 'Wien', '1020', '20', '0', '6', '40 000'),
  r('AT', 'Praha', '1200', '6', '0', '1', '1 000'),
  r('AT', 'Liberec', '4601', '7', '0', '2', '2 000'),
  r('PL', 'Warszawa', '02-972', '4', '0', '5', '7 000'),
  r('DE', 'Berlin', '(neuvedeno)', '5', '0', '5', '30 000'),
  r('DE Celkem', '', '', '5', '0', '5', '30 000'),
].join('\n');

// Vlevo všechny obce (bez PSČ), vpravo rozpad velkých měst podle PSČ v kompaktní formě (obec jen u prvního řádku).
const VEDLE = [
  r('Objednávky dle měst – počet a hodnota (výchozí filtr: Rok 2025 + 2026)', '', '', '', '', '', '', '', '', ''),
  r('', '', '', '', '', 'Rozpad velkých měst dle PSČ →  (filtry nastavujte v obou tabulkách)', '', '', '', ''),
  r('Rok', '(Více položek)', '', '', '', 'Rok', '(Více položek)', '', '', ''),
  r('Země', '(Vše)', '', '', '', 'Země', '(Vše)', '', '', ''),
  r('Napárováno přes', '(Vše)', '', '', '', 'Napárováno přes', '(Vše)', '', '', ''),
  prazdny(10),
  r('Obec', 'Počet objednávek', 'Hodnota objednávek (Kč)', 'Průměrná objednávka (Kč)', '', 'Obec', 'PSČ', 'Počet objednávek ', 'Hodnota objednávek (Kč) ', 'Průměrná objednávka (Kč) '),
  r('Praha', '1 000', '5 000 000', '5 000', '', 'Praha', '160 00', '600', '3 000 000', '5 000'),
  r('(neuvedeno)', '500', '2 500 000', '5 000', '', '', '150 00', '300', '1 500 000', '5 000'),
  r('Brno', '400', '1 600 000', '4 000', '', '', '(neuvedeno)', '60', '300 000', '5 000'),
  r('Teplice', '150', '600 000', '4 000', '', '', '1500', '40', '200 000', '5 000'),
  r('Bratislava', '100', '300 000', '3 000', '', 'Praha Celkem', '', '1 000', '5 000 000', '5 000'),
  r('Košice', '50', '150 000', '3 000', '', 'Brno', '602 00', '300', '1 200 000', '4 000'),
  r('Žilina', '40', '120 000', '3 000', '', '', '617 00', '100', '400 000', '4 000'),
  r('Nová Ves', '30', '90 000', '3 000', '', 'Brno Celkem', '', '400', '1 600 000', '4 000'),
  r('Praha 6 - Dejvice', '20', '60 000', '3 000', '', 'Bratislava', '851 01', '90', '270 000', '3 000'),
  r('Ostrava-Poruba', '15', '45 000', '3 000', '', '', '(neuvedeno)', '10', '30 000', '3 000'),
  r('Brno-venkov', '5', '15 000', '3 000', '', 'Bratislava Celkem', '', '100', '300 000', '3 000'),
  r('Most pri Bratislave', '4', '12 000', '3 000', '', 'Celkový součet', '', '1 500', '6 900 000', '4 600'),
  r('<img src=x onerror=alert(1)>', '2', '6 000', '3 000', '', '', '', '', '', ''),
  r('Celkový součet', '2 316', '10 498 000', '4 533', '', '', '', '', '', ''),
].join('\n');

// Křížová tabulka (roky ve sloupcích, „Celkový součet“ jako sloupec, nad ní „Počet objednávek | Rok“) a vedle
// rozpad podle PSČ, jehož záhlaví je o řádek výš.
const KRIZOVA = [
  r('Objednávky nad 20 000 Kč dle měst a let', '', '', '', '', '', '', '', '', '', ''),
  r('', '', '', '', '', '', '', 'Rozpad velkých měst dle PSČ →', '', '', ''),
  r('Nad limit', '(Více položek)', '', '', '', '', '', 'Nad limit', '(Více položek)', '', ''),
  prazdny(11),
  r('Počet objednávek', 'Rok', '', '', '', '', '', 'Obec', 'PSČ', 'Počet objednávek ', 'Hodnota objednávek (Kč)'),
  r('Obec', '2024', '2025', '2026', 'Celkový součet', '', '', 'Praha', '160 00', '30', '900 000'),
  r('Praha', '', '10', '30', '40', '', '', '', '150 00', '10', '300 000'),
  r('Brno', '', '', '5', '5', '', '', 'Praha Celkem', '', '40', '1 200 000'),
  r('Liberec', '1', '', '2', '3', '', '', 'Celkový součet', '', '40', '1 200 000'),
  r('Celkový součet', '1', '10', '37', '48', '', '', '', '', '', ''),
].join('\n');

// Jen zákazníci a aktivní zákazníci; slovenská Modra × moravská Modrá, Komárno a Senec (mají české jmenovce).
const ZAKAZNICI = [
  r('Zákazníci dle měst (unikátní zákazníci z adresáře, sestupně)', '', '', '', '', '', '', ''),
  prazdny(8),
  r('', '', '', '', 'Rozpad velkých měst dle PSČ →', '', '', ''),
  r('Země (odhad)', '(Vše)', '', '', 'Země (odhad)', '(Vše)', '', ''),
  r('Aktivní', '(Více položek)', '', '', 'Aktivní', '(Více položek)', '', ''),
  prazdny(8),
  r('Obec (sjednoc.)', 'Zákazníků', 'Z toho aktivních', '', 'Obec (sjednoc.)', 'PSČ (sjednoc.)', 'Zákazníků ', 'Z toho aktivních '),
  r('(neuvedeno)', '1 000', '50', '', 'Praha', '160 00', '300', '30'),
  r('Praha', '500', '40', '', '', '(neuvedeno)', '190', '8'),
  r('Komárno', '60', '1', '', '', '1200', '10', '2'),
  r('Senec', '50', '0', '', 'Praha Celkem', '', '500', '40'),
  r('Modrá', '30', '0', '', 'Celkový součet', '', '500', '40'),
  r('Modra', '40', '1', '', '', '', '', ''),
  r('??????', '20', '0', '', '', '', '', ''),
  r('doplnit', '10', '0', '', '', '', '', ''),
  r('Celkový součet', '1 710', '92', '', '', '', '', ''),
].join('\n');

// Osnova se mezisoučtem nad skupinou (řádek obce s prázdným PSČ, pod ním PSČ bez popisku obce).
const OSNOVA = [
  r('Skupina', 'Obec', 'PSČ', 'Zákazníků'),
  r('PREMIUM', 'Praha', '', '100'),
  r('', '', '160 00', '60'),
  r('', '', '150 00', '40'),
  r('', 'Brno', '602 00', '50'),
  r('Prodejní', 'Praha', '160 00', '10'),
  r('Celkový součet', '', '', '160'),
].join('\n');

// Malé české číselníky pro testy: PSČ → [lat, lon, okres, obec, kód obce] a název obce → PSČ největšího sídla.
const PSC = {
  16000: [50.1, 14.39, 3100, 'Praha', 554782],
  14200: [50.03, 14.45, 3100, 'Praha', 554782],
  12000: [50.07, 14.43, 3100, 'Praha', 554782],
  15000: [50.07, 14.38, 3100, 'Praha', 554782],
  60200: [49.2, 16.61, 3702, 'Brno', 582786],
  61700: [49.17, 16.62, 3702, 'Brno', 582786],
  62100: [49.24, 16.56, 3702, 'Brno', 582786],
  25088: [50.16, 14.77, 3209, 'Čelákovice', 538132],
  46001: [50.77, 14.96, 3505, 'Liberec', 563889],
  46010: [50.78, 14.96, 3505, 'Liberec', 563889],
  41501: [50.64, 13.82, 3509, 'Teplice', 567442],
  70030: [49.79, 18.24, 3807, 'Ostrava', 554821],
  25065: [50.22, 14.54, 3209, 'Nová Ves', 538558],
  27301: [50.1, 14.0, 3203, 'Žilina', 533149],
  39117: [49.32, 14.75, 3308, 'Košice', 552585],
  68706: [49.11, 17.4, 3711, 'Modrá', 592391],
  43401: [50.5, 13.64, 3508, 'Most', 567027],
  27036: [50.06, 13.7, 3212, 'Senec', 542369],
};
const OBCE = new Map([
  ['praha', '14200'],
  ['brno', '62100'],
  ['celakovice', '25088'],
  ['liberec', '46001'],
  ['teplice', '41501'],
  ['ostrava', '70030'],
  ['nova ves', '25065'],
  ['zilina', '27301'],
  ['kosice', '39117'],
  ['modra', '68706'],
  ['most', '43401'],
  ['senec', '27036'],
]);
const VELKA = new Set(['praha', 'brno', 'ostrava', 'liberec', 'most', 'teplice']);

module.exports = { PLOCHA, VEDLE, KRIZOVA, ZAKAZNICI, OSNOVA, PSC, OBCE, VELKA };
