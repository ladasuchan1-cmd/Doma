'use strict';
// Admin → Poptávky nabídek (/admin/nabidky): seznam poptávek z konfigurátoru /nabidka (řádky outboxu typu 'nabidka') a
// detail s dešifrovanými kontaktními údaji, konfigurací, výsledkem pro klienta a interním pohledem (marže, náklady, podíl
// partnera, varování) tak, jak byly uloženy při odeslání. Vstup: data z src/features/nabidka.js. Výstup: Html.

const s = require('./shared');
const { html, c } = s;
const { summaryFragment, kc } = require('../nabidka');

function list({ rows, total, page, pages, config, configError }) {
  return html`
${configError ? s.card({ tone: 'danger', compact: true, children: c.notice(html`Konfigurace cen (config/nabidka.json) není použitelná – konfigurátor zobrazuje „nabídka se připravuje“. ${configError}`, 'danger') }) : ''}
${config ? s.card({ compact: true, children: html`<p class="small muted">Ceník verze <strong>${config.meta.verze}</strong>, platnost od ${s.format.date(config.meta.platnostOd)}${config.meta.zastupneCeny ? html` ${c.badge('ukázkové ceny', 'warning')}` : ''}; práh marže ${Math.round(config.interni.prahMarzeProcent * 100)} %. Zdroj: config/nabidka.json, model: docs/NABIDKA-MODEL.md.</p>` }) : ''}
${s.card({
    title: `Poptávky (${total})`,
    children: html`${s.table({
      id: 'nabidky',
      head: ['Přijato', 'Číslo', 'Ubytování / půjčovna', 'Obec', { label: 'Kol', align: 'right', sort: 'num' }, 'Pořízení', { label: 'Měsíčně', align: 'right', sort: 'num' }, { label: 'Jednorázově', align: 'right', sort: 'num' }, 'Marže', 'E-mail'],
      rows: rows.map((r) => {
        const v = r.payload.vysledek || {};
        const i = r.payload.interni || null;
        const sou = v.souhrn || {};
        return [
          s.dt(r.createdAt),
          html`<a class="mono" href="/admin/nabidky/${r.id}">${r.number}</a>`,
          r.nazev || html`<span class="muted">–</span>`,
          r.obec || html`<span class="muted">–</span>`,
          String(sou.pocetKol ?? ''),
          v.porizeni ? v.porizeni.label : '',
          s.money((sou.mesicne || 0) * 100),
          s.money((sou.jednorazove || 0) * 100),
          i ? c.badge(`${Math.round(i.marzeProcent * 100)} %`, i.varovani && i.varovani.some((x) => /pod prahem/.test(x)) ? 'danger' : 'success') : html`<span class="muted">–</span>`,
          r.sentAt ? c.badge('odesláno', 'success') : c.badge('ve frontě', 'warning'),
        ];
      }),
      empty: 'Zatím žádné poptávky. Konfigurátor je na /nabidka.',
    })}
    ${s.pager({ page, pages, href: '/admin/nabidky' })}`,
  })}`;
}

function detail({ row, payload, contact }) {
  const v = payload.vysledek || null;
  const i = payload.interni || null;
  const cenik = payload.cenik || {};
  const contactRows = [
    ['Ubytování / půjčovna', contact.nazev || html`<span class="muted">–</span>`],
    ['Obec', contact.obec || html`<span class="muted">–</span>`],
    ['Kontaktní osoba', contact.osoba || html`<span class="muted">–</span>`],
    ['E-mail', contact.email ? html`<a href="mailto:${contact.email}">${contact.email}</a>` : html`<span class="muted">–</span>`],
    ['Telefon', contact.telefon ? html`<a href="tel:${String(contact.telefon).replace(/\s+/g, '')}">${contact.telefon}</a>` : html`<span class="muted">–</span>`],
    ['Přijato', s.format.dateTime(row.created_at)],
    ['E-mail provozovateli', row.sent_at ? c.badge(`odesláno ${s.format.dateTime(row.sent_at)}`, 'success') : row.error ? c.badge('chyba', 'danger') : c.badge('ve frontě', 'warning')],
    ['Ceník', html`verze ${cenik.verze || '?'}${cenik.zastupneCeny ? html` ${c.badge('ukázkové ceny', 'warning')}` : ''}`],
  ];
  const konf = payload.konfigurace || {};
  const konfRows = [
    ['Kola', html`${['zakladni', 'trek', 'ekolo'].map((k) => `${k}: ${(konf.kola && konf.kola[k]) || 0}`).join(' · ')}`],
    ['Pořízení', konf.porizeni || ''],
    ['Web', html`${konf.web || ''}${konf.dalsiDesign ? ' + další design' : ''}`],
    ['Správa', konf.sprava || ''],
    ['Servis', konf.servis || ''],
    ['Doplňky', (konf.doplnky || []).join(', ') || html`<span class="muted">žádné</span>`],
  ];
  return html`
<div class="admin-grid admin-grid--head">
  ${s.card({ title: 'Kontakt', children: html`${c.summary(contactRows)}${contact.poznamka ? html`<h3 class="admin-card__subtitle">Poznámka klienta</h3><pre class="admin-pre">${contact.poznamka}</pre>` : ''}<p class="small muted">Zobrazení kontaktních údajů je zapsáno v auditu (nabidka.view).</p>` })}
  ${s.card({ title: 'Konfigurace', children: html`${c.summary(konfRows)}<p class="small muted">Query konfigurátoru:</p><pre class="admin-pre">${payload.query || ''}</pre>` })}
</div>
<div class="admin-grid admin-grid--head">
  ${s.card({ title: 'Nabídka pro klienta (jak ji viděl)', children: v ? html`<div class="nab-summary nab-summary--static">${summaryFragment({ result: v, internal: false, actions: false })}</div>` : c.notice('Výsledek není uložen.', 'warning') })}
  ${s.card({
    title: 'Interně: naše marže',
    tone: i && i.varovani && i.varovani.some((x) => /pod prahem/.test(x)) ? 'danger' : undefined,
    children: i
      ? html`${c.summary([
          [`Tržby za ${i.horizontMesice} měsíců`, kc(i.trzby)],
          ['Náklady', kc(i.naklady)],
          ['Podíl partnera (servis)', kc(i.podilPartnera)],
          i.nakupniCelkem ? ['Vázaný kapitál (nákupní ceny kol)', kc(i.nakupniCelkem)] : null,
          { label: `Marže (${Math.round(i.marzeProcent * 100)} %, práh ${Math.round(i.prahMarzeProcent * 100)} %)`, value: kc(i.marze), strong: true },
        ].filter(Boolean))}
      ${s.table({ sortable: false, head: ['Položka', { label: 'Tržby', align: 'right' }, { label: 'Náklady', align: 'right' }, { label: 'Marže', align: 'right' }], rows: (i.polozky || []).map((p) => [html`${p.label}<br><small class="muted">${p.perioda}${p.poznamka ? html` · ${p.poznamka}` : ''}</small>`, kc(p.trzby), kc(p.naklady), html`${kc(p.marze)} <small class="muted">(${Math.round(p.marzeProcent * 100)} %)</small>`]), empty: 'Bez položek.' })}
      ${(i.varovani || []).map((w) => c.notice(w, 'warning'))}`
      : c.notice('Interní čísla nejsou uložena.', 'info'),
  })}
</div>
${s.card({ title: 'Text e-mailu provozovateli', children: html`<pre class="admin-pre">${row.body_text}</pre>` })}`;
}

module.exports = { list, detail };
