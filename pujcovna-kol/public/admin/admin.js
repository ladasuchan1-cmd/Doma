// Progresivní JS administrace (SPEC kap. 13): bez něj vše funguje přes klasické formuláře. Přidává:
//   – potvrzovací dialog u formulářů s data-confirm (nativní <dialog>),
//   – toast ze serverové hlášky (.admin-flash[data-toast]) a vlastní toasty,
//   – řazení a filtr tabulek (table[data-sortable], input[data-table-filter]),
//   – rozbalování kusů v kalendáři (řádky data-parent, tlačítko „Rozbalit vše“),
//   – automatické odeslání select[data-autosubmit] (skryje tlačítko Uložit),
//   – automatický přepočet polí s data-money (čárka → tečka),
//   – vypořádání při uzavření rezervace (form[data-settlement]): částka doplatku se snižuje o stržení z kauce, aby se
//     škoda neinkasovala dvakrát (server totéž hlídá a kombinaci s přeplatkem odmítá 422).
// Načítá se po dom.js, toast.js, modal.js, table.js (všechny <script defer> v pořadí).
(function () {
  'use strict';
  const PKAdmin = window.PKAdmin || {};
  const { h } = PKAdmin;
  document.documentElement.classList.add('js');

  // --- flash → toast -----------------------------------------------------------------------------------
  document.querySelectorAll('.admin-flash[data-toast]').forEach((flash) => {
    const notice = flash.querySelector('.notice');
    if (!notice || !PKAdmin.toast) return;
    const node = document.createDocumentFragment();
    [...notice.childNodes].forEach((n) => node.appendChild(n.cloneNode(true)));
    PKAdmin.toast('', { tone: flash.dataset.toast || 'info', node, timeout: flash.dataset.toast === 'success' ? 6000 : 0 });
  });

  // --- potvrzení formulářů ------------------------------------------------------------------------------
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    let confirmed = false;
    form.addEventListener('submit', (e) => {
      if (confirmed || !PKAdmin.confirmDialog) return;
      e.preventDefault();
      const submitter = e.submitter;
      const danger = submitter ? submitter.classList.contains('btn--danger') : /storno|smazat|anonymiz/i.test(form.action);
      PKAdmin.confirmDialog({ message: form.dataset.confirm, danger, confirmLabel: submitter && submitter.textContent ? submitter.textContent.trim() : 'Potvrdit' }).then((ok) => {
        if (!ok) return;
        confirmed = true;
        if (submitter && submitter.name) {
          const hidden = h('input', { type: 'hidden', name: submitter.name, value: submitter.value || '' });
          form.appendChild(hidden);
        }
        form.requestSubmit ? form.requestSubmit() : form.submit();
      });
    });
  });

  // --- tabulky -------------------------------------------------------------------------------------------
  if (PKAdmin.enhanceTables) PKAdmin.enhanceTables(document);

  // --- vodorovný posun tabulek: vyblednuté okraje + nápověda, klávesnicí posouvatelný kontejner ----------
  document.querySelectorAll('.table-scroll').forEach((box) => {
    const wrap = box.querySelector('.table-wrap');
    if (!wrap) return;
    let hint = null;
    const update = () => {
      const scrollable = wrap.scrollWidth > wrap.clientWidth + 1;
      box.classList.toggle('is-scrollable', scrollable);
      box.classList.toggle('is-scroll-left', scrollable && wrap.scrollLeft > 1);
      box.classList.toggle('is-scroll-right', scrollable && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
      if (scrollable) {
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', 'Tabulka – posouvá se do stran');
        if (!hint) {
          hint = h('p', { class: 'table-scroll__hint' }, 'Tabulka je širší než obrazovka – posouvejte ji do stran.');
          box.parentNode.insertBefore(hint, box.nextSibling);
        }
      } else {
        wrap.removeAttribute('tabindex');
        wrap.removeAttribute('role');
        wrap.removeAttribute('aria-label');
        if (hint) {
          hint.remove();
          hint = null;
        }
      }
    };
    wrap.addEventListener('scroll', update, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(update).observe(wrap);
    else window.addEventListener('resize', update);
    update();
  });

  // --- select s automatickým odesláním -----------------------------------------------------------------
  document.querySelectorAll('select[data-autosubmit]').forEach((sel) => {
    const form = sel.closest('form');
    if (!form) return;
    form.querySelectorAll('[data-autosubmit-hide]').forEach((b) => (b.hidden = true));
    sel.addEventListener('change', () => (form.requestSubmit ? form.requestSubmit() : form.submit()));
  });

  // --- peníze: čárka → tečka (input type=number vyžaduje tečku) ----------------------------------------
  document.querySelectorAll('input[data-money]').forEach((inp) => {
    inp.addEventListener('blur', () => {
      if (inp.value.includes(',')) inp.value = inp.value.replace(/\s+/g, '').replace(',', '.');
    });
  });

  // --- uzavření rezervace: doplatek = dlužná částka − stržení z kauce (nikdy obojí) -----------------------
  document.querySelectorAll('form[data-settlement]').forEach((form) => {
    const due = Number(form.dataset.due) || 0;
    const maxCapture = Number(form.dataset.maxCapture) || 0;
    const el = form.elements;
    const action = el.kauce_akce;
    const capture = el.strhnout_castka;
    const method = el.doplatek_metoda;
    const amount = el.doplatek_castka;
    if (!action || !capture || !method || !amount) return;
    const toMinor = (v) => {
      const n = Number(String(v || '').replace(/\s+/g, '').replace(',', '.'));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
    };
    const toKc = (minor) => (minor / 100).toFixed(minor % 100 === 0 ? 0 : 2);
    const remainingLabel = form.querySelector('[data-settlement-remaining]');
    const update = () => {
      const captured = action.value === 'strhnout' ? Math.min(toMinor(capture.value), maxCapture) : 0;
      const remaining = Math.max(0, due - captured);
      amount.value = toKc(remaining);
      amount.max = toKc(remaining);
      if (remainingLabel) remainingLabel.textContent = `${toKc(remaining).replace('.', ',')} Kč`;
      const nothingLeft = remaining === 0;
      if (nothingLeft) method.value = '';
      method.disabled = nothingLeft;
      amount.disabled = nothingLeft;
      method.closest('.field').classList.toggle('is-disabled', nothingLeft);
      amount.closest('.field').classList.toggle('is-disabled', nothingLeft);
    };
    action.addEventListener('change', update);
    capture.addEventListener('input', update);
    capture.addEventListener('change', update);
    // odeslání: vypnutá pole se neodesílají – server bere chybějící doplatek jako „Neuhrazen“
    update();
  });

  // --- kalendář: rozbalování kusů -----------------------------------------------------------------------
  const timeline = document.querySelector('.timeline--admin');
  if (timeline) {
    const groups = [...timeline.querySelectorAll('.timeline__row--type[data-group]')];
    const children = (id) => [...timeline.querySelectorAll(`.timeline__row[data-parent="${id}"]`)];
    const setOpen = (row, open) => {
      row.dataset.open = open ? '1' : '0';
      children(row.dataset.group).forEach((r) => r.classList.toggle('is-collapsed', !open));
      const btn = row.querySelector('.timeline__toggle');
      if (btn) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? '−' : '+';
        btn.setAttribute('aria-label', open ? 'Skrýt kusy' : 'Zobrazit kusy');
      }
    };
    groups.forEach((row) => {
      const label = row.querySelector('.timeline__label');
      if (!label || !children(row.dataset.group).length) return;
      const btn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm timeline__toggle', 'aria-expanded': 'false', onClick: () => setOpen(row, row.dataset.open !== '1') }, '+');
      label.appendChild(btn);
      setOpen(row, false);
    });
    const all = document.querySelector('[data-timeline-toggle]');
    if (all && groups.length) {
      all.hidden = false;
      let opened = false;
      all.addEventListener('click', () => {
        opened = !opened;
        groups.forEach((row) => setOpen(row, opened));
        all.textContent = opened ? 'Sbalit vše' : 'Rozbalit vše';
      });
    }
  }

  // --- zavřít dialogy při navigaci zpět -----------------------------------------------------------------
  window.addEventListener('pagehide', () => PKAdmin.closeAllModals && PKAdmin.closeAllModals());
})();
