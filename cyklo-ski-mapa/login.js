// Přihlašovací stránka: doplní do cíle po přihlášení i část adresy za # (kraj, okres, vybrané místo),
// kterou prohlížeč na server neposílá – odkaz od kolegy tak po přihlášení otevře totéž místo.
(function () {
  var next = document.querySelector('input[name="next"]');
  if (next && location.hash && next.value.indexOf('#') < 0) next.value += location.hash;
})();
