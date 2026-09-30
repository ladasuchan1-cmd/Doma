/**
 * Dotazník „PREZENTACE LÁĎA - 1.10.2026“ – vytvoří Google Formulář + QR kód.
 *
 * Postup:
 *  1. Otevři https://script.google.com → „Nový projekt“.
 *  2. Smaž obsah a vlož celý tento soubor.
 *  3. Nahoře vyber funkci „vytvorDotaznik“ a klikni na ▶ Spustit.
 *  4. Povol přístup (Formuláře + Disk) svým Google účtem.
 *  5. V „Protokolu provádění“ najdeš odkazy. QR kód (PNG) se uloží na Disk
 *     do složky „Dotazník prezentace“ – stáhni ho a vlož do prezentace.
 */
function vytvorDotaznik() {
  var form = FormApp.create('PREZENTACE LÁĎA - 1.10.2026');
  form.setTitle('PREZENTACE LÁĎA - 1.10.2026')
      .setDescription('Díky, že jste dorazili.\nMám otázky, ať to můžeme zlepšovat.')
      .setCollectEmail(false)
      .setLimitOneResponsePerUser(false)
      .setProgressBar(false)
      .setConfirmationMessage('Díky za zpětnou vazbu!');

  var skaly = [
    'Jak hodnotíš prezentaci celkem?',
    'Jak hodnotíš kvalitu dodaných informací?',
    'Dozvěděl/a ses něco nového?',
    'Chceš zachovat tento muster pro ostatní členy obchodního týmu?'
  ];
  skaly.forEach(function (otazka) {
    form.addScaleItem()
        .setTitle(otazka)
        .setBounds(1, 10)
        .setLabels('1 = nejhorší', '10 = nejlepší')
        .setRequired(true);
  });

  form.addParagraphTextItem()
      .setTitle('Pokud chceš reagovat či upřesnit svůj pohled, prosím, napiš to sem.')
      .setRequired(false);

  // Odpovědi zároveň do Google Tabulky
  var sheet = SpreadsheetApp.create('PREZENTACE LÁĎA - 1.10.2026 (odpovědi)');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  // Krátký veřejný odkaz + QR kód
  var odkaz = form.shortenFormUrl(form.getPublishedUrl());
  var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&margin=20&data=' +
              encodeURIComponent(odkaz);
  var qrPng = UrlFetchApp.fetch(qrUrl).getBlob().setName('QR - Prezentace Láďa 1.10.2026.png');

  var slozka = DriveApp.createFolder('Dotazník prezentace');
  var qrSoubor = slozka.createFile(qrPng);
  DriveApp.getFileById(form.getId()).moveTo(slozka);
  DriveApp.getFileById(sheet.getId()).moveTo(slozka);

  Logger.log('Odkaz pro kolegy:   ' + odkaz);
  Logger.log('Úprava formuláře:   ' + form.getEditUrl());
  Logger.log('Tabulka odpovědí:   ' + sheet.getUrl());
  Logger.log('QR kód (PNG):       ' + qrSoubor.getUrl());
  Logger.log('QR kód (přímý obr): ' + qrUrl);
}
