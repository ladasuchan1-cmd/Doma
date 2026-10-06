// Tabulky: klientské řazení kliknutím na záhlaví (data-sort="text|num", aria-sort) a rychlý filtr řádků
// (input[data-table-filter="<id tabulky>"]). Vzor ../repricing/public/lib/table.js (sortRows), bez modulů.
(function () {
  'use strict';
  const PKAdmin = (window.PKAdmin = window.PKAdmin || {});
  const collator = new Intl.Collator('cs', { sensitivity: 'base', numeric: true });

  function cellValue(td, kind) {
    const time = td.querySelector('time[datetime]');
    if (time) return Date.parse(time.getAttribute('datetime')) || 0;
    const text = td.textContent.trim().replace(/ /g, ' ');
    if (kind === 'num') {
      const n = Number(text.replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    return text;
  }

  function sortRows(rows, index, kind, dir) {
    const mul = dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const va = cellValue(a.children[index], kind);
      const vb = cellValue(b.children[index], kind);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
      return collator.compare(String(va), String(vb)) * mul;
    });
  }

  function enhanceTable(table) {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const heads = [...table.querySelectorAll('thead th')];
    heads.forEach((th, index) => {
      const kind = th.dataset.sort;
      if (!kind || kind === 'none') return;
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      th.setAttribute('aria-sort', 'none');
      const go = () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? 'desc' : 'asc';
        heads.forEach((x) => x.dataset.sort && x.dataset.sort !== 'none' && x.setAttribute('aria-sort', 'none'));
        th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
        const sorted = sortRows([...tbody.rows], index, kind, dir);
        sorted.forEach((tr) => tbody.appendChild(tr));
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    });
  }

  function enhanceFilter(input) {
    const table = document.getElementById(input.dataset.tableFilter);
    if (!table || !table.tBodies[0]) return;
    const rows = [...table.tBodies[0].rows];
    const texts = rows.map((tr) => tr.textContent.toLowerCase().replace(/\s+/g, ' '));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      rows.forEach((tr, i) => {
        tr.hidden = !!q && !texts[i].includes(q);
      });
    });
  }

  PKAdmin.enhanceTables = function enhanceTables(root) {
    (root || document).querySelectorAll('table[data-sortable]').forEach(enhanceTable);
    (root || document).querySelectorAll('input[data-table-filter]').forEach(enhanceFilter);
  };
  PKAdmin.sortRows = sortRows;
})();
