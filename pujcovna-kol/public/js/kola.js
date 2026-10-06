'use strict';
// Progresivní JS feature „kola“: (1) filtry na /kola se odešlou samy při změně (bez JS funguje tlačítko Zobrazit),
// (2) galerie na detailu – klik na náhled vymění hlavní fotku bez načtení stránky. Žádné knihovny, žádný inline kód.
(function () {
  function initFilters() {
    var form = document.querySelector('form[data-autosubmit]');
    if (!form) return;
    var timer = null;
    form.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || !el.name) return;
      // termín odesílat až když jsou vyplněná obě data (nebo žádné)
      var od = form.querySelector('[name="od"]');
      var dd = form.querySelector('[name="do"]');
      if ((el.name === 'od' || el.name === 'do') && od && dd && ((od.value && !dd.value) || (!od.value && dd.value))) {
        if (el.name === 'od' && od.value && !dd.value) dd.min = od.value;
        return;
      }
      if (od && dd && od.value && dd.value && dd.value < od.value) {
        dd.value = od.value;
      }
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }, 150);
    });
  }

  function initGallery() {
    var gallery = document.querySelector('[data-gallery]');
    if (!gallery) return;
    var main = gallery.querySelector('.gallery__main');
    var thumbs = gallery.querySelectorAll('.gallery__thumb');
    if (!main || !thumbs.length) return;
    thumbs.forEach(function (thumb) {
      thumb.addEventListener('click', function (e) {
        e.preventDefault();
        main.src = thumb.getAttribute('data-src') || thumb.href;
        main.alt = thumb.getAttribute('data-alt') || '';
        thumbs.forEach(function (t) {
          t.classList.remove('is-active');
          t.removeAttribute('aria-current');
        });
        thumb.classList.add('is-active');
        thumb.setAttribute('aria-current', 'true');
      });
    });
  }

  function initTermForm() {
    var form = document.querySelector('.term-form');
    if (!form) return;
    var od = form.querySelector('[name="od"]');
    var dd = form.querySelector('[name="do"]');
    if (!od || !dd) return;
    od.addEventListener('change', function () {
      if (od.value) {
        dd.min = od.value;
        if (!dd.value || dd.value < od.value) dd.value = od.value;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initFilters();
      initGallery();
      initTermForm();
    });
  } else {
    initFilters();
    initGallery();
    initTermForm();
  }
})();
