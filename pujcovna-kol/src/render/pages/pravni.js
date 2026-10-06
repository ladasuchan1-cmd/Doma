'use strict';
// Stránka: právní text (feature pravni). Vstup: { title, lead, doc: { html, headings }, version, effectiveFrom,
// demo, toc, excerptOf, contact }. Výstup: Html tělo – hlavička stránky, volitelný obsah (h2 z dokumentu),
// článek s vyrenderovaným textem (první h1 dokumentu se vynechá, nadpis má hlavička stránky), volitelná
// kontaktní karta (reklamace) a v demo režimu šedý box „Demo: návrh k advokátní kontrole, verze X“.

const { html, raw } = require('../html');
const c = require('../components');

/** Odstraní první <h1> z HTML dokumentu – nadpis nese hlavička stránky. */
function withoutFirstH1(docHtml) {
  return String(docHtml).replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\n?/, '');
}

function toc(headings) {
  const items = (headings || []).filter((h) => h.level === 2);
  if (items.length < 3) return '';
  return html`<nav class="legal-toc" aria-label="Obsah dokumentu">
  <p class="legal-toc__title">Obsah</p>
  <ol class="legal-toc__list">${items.map((h) => html`<li><a href="#${h.id}">${h.text}</a></li>`)}</ol>
</nav>`;
}

function demoNote(version) {
  return html`<aside class="legal-demo" role="note">Demo: tento text je návrh k advokátní kontrole, verze ${version}. Před ostrým provozem ho musí schválit advokát půjčovny.</aside>`;
}

function legal({ title, lead, doc, version, effectiveFrom, demo, toc: showToc = true, excerptOf, contact }) {
  const meta = [version ? `Verze ${version}` : null, effectiveFrom ? `účinná od ${effectiveFrom}` : null].filter(Boolean).join(', ');
  return html`
${c.section({ variant: 'page-head', title, titleTag: 'h1', lead })}
<section class="section section--legal">
  <div class="container legal-layout">
    ${showToc ? toc(doc.headings) : ''}
    <div class="legal-main">
      <p class="legal-meta">${meta}${excerptOf ? html` · výňatek z dokumentu <a href="${excerptOf.href}">${excerptOf.label}</a>` : ''}</p>
      <article class="legal">${raw(withoutFirstH1(doc.html))}</article>
      ${contact ? html`<div class="legal-contact">${c.contactCard(contact.business, contact.openingHours, { title: 'Kde reklamaci uplatnit' })}</div>` : ''}
      ${demo ? demoNote(version) : ''}
    </div>
  </div>
</section>
`;
}

module.exports = { legal, toc, demoNote, withoutFirstH1 };
