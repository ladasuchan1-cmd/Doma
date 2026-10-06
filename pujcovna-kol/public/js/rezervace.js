'use strict';
// Progresivní JS feature „rezervace“ (bez knihoven, bez inline kódu):
//  1. Kalendář výběru rozsahu dat nad komponentou .calendar[data-calendar]: čte data-min, data-max, data-blocked (JSON
//     pole 'YYYY-MM-DD' nebo { from, to }), schová fallback (dva <input type=date> zůstanou ve formuláři a nesou hodnotu),
//     vykreslí měsíční mřížku s navigací; první klik = vyzvednutí, druhý = vrácení. Zavřené dny nelze zvolit jako
//     začátek/konec. Po výběru zavolá /api/v1/dostupnost a vypíše počet volných kol.
//  2. Krok 2: živý součet vybraných kol, ceny a poplatku z data-price / data-fee / data-days.
//  3. Krok 3: tlačítko Pokračovat je aktivní až po zaškrtnutí obou povinných souhlasů (server ověřuje tak jako tak).
(function () {
  var MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  var WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function isoOf(y, m, d) {
    return y + '-' + pad(m + 1) + '-' + pad(d);
  }
  function parseIso(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
  }
  function fmtCz(iso) {
    var p = parseIso(iso);
    return p ? p.d + '. ' + (p.m + 1) + '. ' + p.y : '';
  }
  function money(minor) {
    var kc = Math.round(minor / 100);
    return kc.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
  }
  function plural(n, one, few, many) {
    var a = Math.abs(n);
    return n + ' ' + (a === 1 ? one : a >= 2 && a <= 4 ? few : many);
  }

  // -------------------------------------------------------------------------------------------------------
  // Kalendář

  function initCalendar() {
    var root = document.querySelector('.calendar[data-calendar]');
    if (!root) return;
    var fallback = root.querySelector('.calendar__fallback');
    var grid = root.querySelector('.calendar__grid');
    var fromInput = root.querySelector('input[type="date"][name="od"]');
    var toInput = root.querySelector('input[type="date"][name="do"]');
    if (!fallback || !grid || !fromInput || !toInput) return;
    var min = root.getAttribute('data-min') || '';
    var max = root.getAttribute('data-max') || '';
    var blocked = {};
    try {
      var list = JSON.parse(root.getAttribute('data-blocked') || '[]');
      list.forEach(function (b) {
        if (typeof b === 'string') blocked[b] = true;
        else if (b && b.from) {
          var p = parseIso(b.from);
          var end = b.to || b.from;
          for (var i = 0; i < 400; i++) {
            var dt = new Date(Date.UTC(p.y, p.m, p.d + i, 12));
            var iso = dt.toISOString().slice(0, 10);
            if (iso > end) break;
            blocked[iso] = true;
          }
        }
      });
    } catch (e) {
      blocked = {};
    }
    var today = new Date();
    var todayIso = isoOf(today.getFullYear(), today.getMonth(), today.getDate());
    var start = fromInput.value || '';
    var end = toInput.value || '';
    var view = parseIso(start || min || todayIso) || { y: today.getFullYear(), m: today.getMonth() };
    var form = root.closest('form');
    var status = document.querySelector('[data-availability-status]');
    var fromTime = form ? form.querySelector('[name="od_cas"]') : null;
    var toTime = form ? form.querySelector('[name="do_cas"]') : null;

    root.classList.add('is-enhanced');
    grid.hidden = false;
    grid.removeAttribute('aria-hidden');

    function selectable(iso) {
      if (min && iso < min) return false;
      if (max && iso > max) return false;
      return !blocked[iso];
    }

    function render() {
      var y = view.y;
      var m = view.m;
      var first = new Date(y, m, 1);
      var offset = (first.getDay() + 6) % 7; // pondělí = 0
      var days = new Date(y, m + 1, 0).getDate();
      var html = '';
      html += '<div class="calendar__head">';
      html += '<button type="button" class="btn btn--ghost btn--sm calendar__nav" data-nav="-1" aria-label="Předchozí měsíc">‹</button>';
      html += '<p class="calendar__month" aria-live="polite">' + MONTHS[m] + ' ' + y + '</p>';
      html += '<button type="button" class="btn btn--ghost btn--sm calendar__nav" data-nav="1" aria-label="Další měsíc">›</button>';
      html += '</div>';
      html += '<ul class="calendar__weekdays" aria-hidden="true">' + WEEKDAYS.map(function (w) { return '<li>' + w + '</li>'; }).join('') + '</ul>';
      html += '<ul class="calendar__days" role="listbox" aria-label="Dny v měsíci">';
      for (var e = 0; e < offset; e++) html += '<li><span class="calendar__day is-empty" aria-hidden="true"></span></li>';
      for (var d = 1; d <= days; d++) {
        var iso = isoOf(y, m, d);
        var cls = 'calendar__day';
        if (iso === todayIso) cls += ' is-today';
        if (start && iso === start) cls += ' is-start';
        if (end && iso === end) cls += ' is-end';
        if (start && end && iso > start && iso < end) cls += ' is-in-range';
        var ok = selectable(iso);
        var label = fmtCz(iso) + (blocked[iso] ? ' – zavřeno' : '');
        html += '<li><button type="button" class="' + cls + '" data-date="' + iso + '"' + (ok ? '' : ' disabled') + ' aria-label="' + label + '"' + (iso === start || iso === end ? ' aria-pressed="true"' : '') + '>' + d + '</button></li>';
      }
      html += '</ul>';
      html += '<p class="calendar__selection">' + (start ? 'Vyzvednutí <strong>' + fmtCz(start) + '</strong>' : 'Vyberte den vyzvednutí') + (start && end ? ' · vrácení <strong>' + fmtCz(end) + '</strong>' : start ? ' · vyberte den vrácení' : '') + '</p>';
      grid.innerHTML = html;
    }

    function sync() {
      fromInput.value = start || '';
      toInput.value = end || '';
      if (fromTime && toTime && start && end && start === end && fromTime.value >= toTime.value) {
        // stejný den: čas vrácení alespoň o 2 sloty později, pokud existuje
        var idx = Array.prototype.indexOf.call(toTime.options, toTime.querySelector('option[value="' + fromTime.value + '"]'));
        if (idx >= 0 && idx + 2 < toTime.options.length) toTime.selectedIndex = idx + 2;
      }
      checkAvailability();
    }

    var pending = null;
    function checkAvailability() {
      if (!status) return;
      if (!start || !end) {
        status.textContent = '';
        return;
      }
      var params = new URLSearchParams({ od: start, do: end });
      if (fromTime && fromTime.value) params.set('od_cas', fromTime.value);
      if (toTime && toTime.value) params.set('do_cas', toTime.value);
      status.textContent = 'Zjišťuji dostupnost…';
      if (pending && pending.abort) pending.abort();
      pending = typeof AbortController === 'function' ? new AbortController() : null;
      fetch('/api/v1/dostupnost?' + params.toString(), { credentials: 'same-origin', signal: pending ? pending.signal : undefined })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) {
            status.textContent = data && data.error ? data.error : 'Dostupnost se nepodařilo zjistit.';
            return;
          }
          var typesFree = 0;
          Object.keys(data.available || {}).forEach(function (t) {
            var sizes = data.available[t];
            var n = Object.keys(sizes).reduce(function (s, k) { return s + sizes[k]; }, 0);
            if (n > 0) typesFree++;
          });
          status.textContent = data.total > 0 ? 'V tomto termínu je volných ' + plural(data.total, 'kolo', 'kola', 'kol') + ' (' + plural(typesFree, 'typ', 'typy', 'typů') + ').' : 'V tomto termínu bohužel nemáme volné žádné kolo – zkuste jiný termín.';
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          status.textContent = '';
        });
    }

    grid.addEventListener('click', function (e) {
      // Hledat jen uvnitř mřížky: obecný selektor na atribut data-nav by přes closest() došel až k <html data-nav="…">
      // (atribut tématu z layoutu, např. „transparent“) a Number(…) = NaN by rozbilo zobrazený měsíc.
      var nav = e.target.closest('.calendar__nav[data-nav]');
      if (nav && grid.contains(nav)) {
        var step = Number(nav.getAttribute('data-nav'));
        if (!Number.isFinite(step)) step = 0;
        view.m += step;
        if (view.m < 0) { view.m = 11; view.y--; }
        if (view.m > 11) { view.m = 0; view.y++; }
        render();
        return;
      }
      var day = e.target.closest('.calendar__day[data-date]');
      if (!day || !grid.contains(day) || day.disabled) return;
      var iso = day.getAttribute('data-date');
      if (!start || (start && end)) {
        start = iso;
        end = '';
      } else if (iso < start) {
        start = iso;
      } else {
        end = iso;
      }
      render();
      sync();
    });

    if (fromTime) fromTime.addEventListener('change', checkAvailability);
    if (toTime) toTime.addEventListener('change', checkAvailability);
    render();
    if (start && end) checkAvailability();
  }

  // -------------------------------------------------------------------------------------------------------
  // Krok 2: součty

  function initBikeForm() {
    var form = document.querySelector('form[data-bike-form]');
    if (!form) return;
    var summary = form.querySelector('[data-pick-summary]');
    if (!summary) return;
    var countEl = summary.querySelector('[data-pick-count]');
    var totalEl = summary.querySelector('[data-pick-total]');
    var feeEl = summary.querySelector('[data-pick-fee]');
    function recalc() {
      var count = 0;
      var total = 0;
      var fee = 0;
      form.querySelectorAll('.bike-pick__qty').forEach(function (inp) {
        var q = Math.max(0, Math.floor(Number(inp.value) || 0));
        var max = Number(inp.max);
        if (Number.isFinite(max) && q > max) {
          q = max;
          inp.value = q;
        }
        count += q;
        total += q * (Number(inp.getAttribute('data-price')) || 0);
        fee += q * (Number(inp.getAttribute('data-fee')) || 0);
      });
      form.querySelectorAll('.accessories__qty').forEach(function (inp) {
        var q = Math.max(0, Math.floor(Number(inp.value) || 0));
        total += q * (Number(inp.getAttribute('data-price')) || 0) * (Number(inp.getAttribute('data-days')) || 1);
      });
      summary.hidden = count === 0;
      if (countEl) countEl.textContent = String(count);
      if (totalEl) totalEl.textContent = money(total);
      if (feeEl) feeEl.textContent = money(fee);
    }
    form.addEventListener('input', recalc);
    form.addEventListener('change', recalc);
    recalc();
  }

  // -------------------------------------------------------------------------------------------------------
  // Krok 3: povinné souhlasy

  function initConsentForm() {
    var form = document.querySelector('form[data-consent-form]');
    if (!form) return;
    var boxes = form.querySelectorAll('input[data-required-consent]');
    var submit = form.querySelector('button[type="submit"]');
    if (!boxes.length || !submit) return;
    function update() {
      var ok = Array.prototype.every.call(boxes, function (b) { return b.checked; });
      submit.disabled = !ok;
      submit.setAttribute('aria-disabled', ok ? 'false' : 'true');
      submit.title = ok ? '' : 'Nejprve potvrďte obě povinná zaškrtávátka.';
    }
    boxes.forEach(function (b) { b.addEventListener('change', update); });
    update();
  }

  function init() {
    initCalendar();
    initBikeForm();
    initConsentForm();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
