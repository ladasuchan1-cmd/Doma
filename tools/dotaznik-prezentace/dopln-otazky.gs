/**
 * Doplní otázky o značkách do už existujícího formuláře
 * „PREZENTACE LÁĎA - 1.10.2026“. Odkaz ani QR kód se nemění.
 * Spusť funkci „doplnOtazky“. Při opakovaném spuštění nic nezdvojí.
 */
function doplnOtazky() {
  var soubory = DriveApp.getFilesByName('PREZENTACE LÁĎA - 1.10.2026');
  var form = null;
  while (soubory.hasNext()) {
    var f = soubory.next();
    if (f.getMimeType() === MimeType.GOOGLE_FORMS && !f.isTrashed()) { form = FormApp.openById(f.getId()); break; }
  }
  if (!form) throw new Error('Formulář „PREZENTACE LÁĎA - 1.10.2026“ jsem na Disku nenašel.');

  var existujici = form.getItems().map(function (i) { return i.getTitle(); });
  var nove = [
    ['Jakých 5 značek vnímáš ty sám jako nejprodejnější?', 'Napiš 5 značek, ideálně každou na nový řádek.'],
    ['Jaké značky tě naopak odrazují, či je nechceš / neumíš prodávat?', ''],
    ['Je nějaká značka, kterou bys chtěl naopak prodávat navíc?', ''],
    ['Je něco, co chceš dodat, říct nebo připomenout? Napiš.', '']
  ];
  nove.forEach(function (q) {
    if (existujici.indexOf(q[0]) !== -1) return;
    form.addParagraphTextItem().setTitle(q[0]).setHelpText(q[1]).setRequired(false);
  });

  Logger.log('Hotovo. Úprava formuláře: ' + form.getEditUrl());
  Logger.log('Odkaz pro kolegy (beze změny): ' + form.getPublishedUrl());
}
