'use strict';
// Progresivní JS feature „nabídka“: (1) při změně formuláře konfigurátoru načte /api/v1/nabidka/spocitat?… a vymění obsah
// souhrnu (pole `html` z odpovědi = stejný SSR fragment), (2) aktualizuje hidden pole konfigurace v poptávce a adresu
// stránky (history.replaceState), (3) doplňky „jen e-kola“ povoluje podle počtu e-kol, (4) tlačítko Vytisknout nabídku.
// Bez JS funguje tlačítko „Přepočítat nabídku“ (GET formulář). Žádné knihovny, žádný inline kód.
(function () {
  var form = document.querySelector('[data-nabidka-form]');
  var summary = document.querySelector('[data-nabidka-summary]');
  if (!form || !summary) return;

  var nojs = form.querySelector('[data-nabidka-nojs]');
  if (nojs) nojs.hidden = true;

  function query() {
    var params = new URLSearchParams();
    var data = new FormData(form);
    data.forEach(function (value, key) {
      params.append(key, String(value));
    });
    return params.toString();
  }

  function syncEkolo() {
    var ekolo = form.querySelector('[data-nabidka-count="ekolo"]');
    var n = ekolo ? parseInt(ekolo.value, 10) || 0 : 0;
    form.querySelectorAll('[data-nabidka-jen-ekolo]').forEach(function (box) {
      box.disabled = n === 0;
      if (n === 0) box.checked = false;
    });
  }

  // zvýraznění množstevního stupně podle celkového počtu kol (stupně s data-od, poslední splněný je aktivní)
  function syncTiers() {
    var n = 0;
    form.querySelectorAll('[data-nabidka-count]').forEach(function (inp) {
      n += parseInt(inp.value, 10) || 0;
    });
    var tiers = document.querySelectorAll('[data-nabidka-tiers] [data-od]');
    var active = null;
    tiers.forEach(function (li) {
      if (n >= (parseInt(li.getAttribute('data-od'), 10) || 0)) active = li;
    });
    tiers.forEach(function (li) {
      var on = li === active;
      li.classList.toggle('is-active', on);
      if (on) li.setAttribute('aria-current', 'true');
      else li.removeAttribute('aria-current');
    });
  }

  function syncChoices() {
    form.querySelectorAll('.nab-choice').forEach(function (label) {
      var input = label.querySelector('.nab-choice__input');
      label.classList.toggle('is-checked', !!(input && input.checked));
    });
  }

  function bindPrint() {
    document.querySelectorAll('[data-nabidka-print]').forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        openDetails(true);
        window.print();
      });
    });
  }

  // <details> se sbaleným rozpisem nelze v tisku otevřít přes CSS → před tiskem otevřít, po tisku vrátit
  var wasOpen = [];
  function openDetails(open) {
    var list = document.querySelectorAll('.nab-summary__details');
    if (open) {
      wasOpen = [];
      list.forEach(function (d) {
        wasOpen.push(d.open);
        d.open = true;
      });
    } else {
      list.forEach(function (d, i) {
        d.open = !!wasOpen[i];
      });
    }
  }
  window.addEventListener('beforeprint', function () {
    openDetails(true);
  });
  window.addEventListener('afterprint', function () {
    openDetails(false);
  });

  var timer = null;
  var controller = null;
  function recalc() {
    var q = query();
    var hidden = document.querySelector('[data-nabidka-konfigurace]');
    if (hidden) hidden.value = q;
    try {
      window.history.replaceState(null, '', form.getAttribute('action') + '?' + q);
    } catch (e) {
      /* nic */
    }
    if (controller) controller.abort();
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    summary.classList.add('is-loading');
    fetch('/api/v1/nabidka/spocitat?' + q, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: controller ? controller.signal : undefined })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data && data.ok && typeof data.html === 'string') {
          summary.innerHTML = data.html;
          bindPrint();
        }
        summary.classList.remove('is-loading');
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        summary.classList.remove('is-loading');
      });
  }

  form.addEventListener('change', function () {
    syncEkolo();
    syncTiers();
    syncChoices();
    clearTimeout(timer);
    timer = setTimeout(recalc, 120);
  });
  form.addEventListener('input', function (e) {
    if (e.target && e.target.type === 'number') {
      clearTimeout(timer);
      timer = setTimeout(function () {
        syncEkolo();
        syncTiers();
        recalc();
      }, 350);
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    recalc();
  });

  syncEkolo();
  syncTiers();
  syncChoices();
  bindPrint();
})();
