/*
 * Detekce, zda je aktuální stránka
 *   a) samotný dokument s podmínkami (obchodní podmínky, GDPR, EULA…), nebo
 *   b) „kontext souhlasu“ – pokladna, registrace, instalace – kde se na podmínky odkazuje.
 * Čistě funkční modul (bez přístupu k DOM), aby šel testovat v Node.
 */
(function (root) {
  'use strict';

  const K = root.TermsKeywords || (typeof require === 'function' ? require('./keywords.js') : null);

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Bez diakritiky porovnáváme i klíčová slova.
  const TITLES_N = K.DOCUMENT_TITLES.map(normalize);
  const DENSITY_N = K.LEGAL_DENSITY_WORDS.map(normalize);
  const CONTEXT_N = Object.fromEntries(
    Object.entries(K.CONSENT_CONTEXT).map(([k, arr]) => [k, arr.map(normalize)])
  );

  function containsAny(haystackN, needlesN) {
    for (const n of needlesN) if (n && haystackN.includes(n)) return n;
    return null;
  }

  function urlTokens(url) {
    try {
      const u = new URL(url);
      const path = normalize(decodeURIComponent(u.pathname + ' ' + u.search + ' ' + u.hash));
      return path.split(/[^a-z0-9_-]+/).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function urlLooksLikeTerms(url) {
    const tokens = urlTokens(url);
    const joined = tokens.join('/');
    for (const t of K.URL_TOKENS) {
      if (tokens.includes(t) || joined.includes(t + '-') || joined.includes('-' + t) || joined.includes(t + '/')) {
        return t;
      }
    }
    return null;
  }

  function legalDensity(textN) {
    if (!textN) return 0;
    let hits = 0;
    for (const w of DENSITY_N) {
      let idx = 0;
      let count = 0;
      while ((idx = textN.indexOf(w, idx)) !== -1 && count < 50) { count++; idx += w.length; }
      hits += count;
    }
    const words = textN.split(' ').length || 1;
    return hits / words; // podíl „právních“ výskytů na slovo
  }

  /**
   * @param {object} page
   * @param {string} page.url
   * @param {string} page.title
   * @param {string[]} page.headings   – texty h1/h2
   * @param {string} page.text         – hlavní text stránky
   * @param {string[]} page.buttons    – texty tlačítek / submitů
   * @param {string[]} page.labels     – texty labelů u checkboxů
   * @param {boolean} page.hasPasswordField
   * @param {boolean} page.hasPaymentField
   * @param {Array<{href:string,text:string}>} page.links
   * @returns {{kind:'document'|'consent'|'none', reason:string, score:number, context:string[], termsLinks:Array}}
   */
  function detect(page) {
    const url = page.url || '';
    const titleN = normalize(page.title);
    const headingsN = (page.headings || []).map(normalize).join(' | ');
    const textN = normalize(page.text || '');
    const buttonsN = (page.buttons || []).map(normalize).join(' | ');
    const labelsN = (page.labels || []).map(normalize).join(' | ');
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();

    const termsLinks = findTermsLinks(page.links || [], url);

    // --- a) Dokument s podmínkami ---
    let docScore = 0;
    const reasons = [];
    const titleHit = containsAny(titleN, TITLES_N) || containsAny(headingsN, TITLES_N);
    if (titleHit) { docScore += 3; reasons.push('nadpis: ' + titleHit); }
    const urlHit = urlLooksLikeTerms(url);
    if (urlHit) { docScore += 2; reasons.push('URL: ' + urlHit); }
    const density = legalDensity(textN);
    const length = textN.length;
    if (length > 1500 && density > 0.012) { docScore += 2; reasons.push('hustota právního textu'); }
    if (length > 6000 && density > 0.02) { docScore += 1; }
    if (length < 800) docScore -= 2; // příliš krátké na dokument

    const hints = { titleHit: titleHit || null, urlHit: urlHit || null };
    if (docScore >= 4 && length >= 800) {
      return Object.assign({
        kind: 'document', reason: reasons.join(', '), score: docScore, context: [],
        termsLinks, density, length, agree: null,
      }, hints);
    }

    // --- b) Kontext souhlasu ---
    const context = [];
    const strong = [];   // silné signály, bez nichž se kontext nevyhlásí (jinak by spustila každá stránka produktu)
    const hay = [titleN, headingsN, buttonsN, labelsN].join(' | ');
    const tokens = urlTokens(url);
    if (K.STORE_HOSTS.includes(host)) { context.push('install'); strong.push('obchod s aplikacemi'); }
    for (const [ctx, needles] of Object.entries(CONTEXT_N)) {
      if (ctx === 'agree') continue;
      if (containsAny(hay, needles) && !context.includes(ctx)) context.push(ctx);
    }
    for (const [ctx, toks] of Object.entries(K.URL_CONTEXT_TOKENS)) {
      if (ctx === 'install' && !K.STORE_HOSTS.includes(host)) continue; // „download“ v URL je příliš obecné
      if (tokens.some((t) => toks.includes(t))) {
        if (!context.includes(ctx)) context.push(ctx);
        strong.push('URL: ' + ctx);
      }
    }
    if (page.hasPasswordField) { if (!context.includes('signup')) context.push('signup'); strong.push('heslo'); }
    if (page.hasPaymentField) { if (!context.includes('checkout')) context.push('checkout'); strong.push('platební pole'); }
    const agreeHit = containsAny(labelsN + ' | ' + buttonsN, CONTEXT_N.agree);
    if (agreeHit) strong.push('souhlas: ' + agreeHit);

    let consentScore = 0;
    if (context.length) consentScore += 2;
    if (strong.length) consentScore += 2;
    if (termsLinks.length) consentScore += 2;

    if (context.length && strong.length && termsLinks.length) {
      return Object.assign({
        kind: 'consent', reason: 'kontext: ' + context.join('+') + ' (' + strong.join(', ') + ')',
        score: consentScore, context, termsLinks, density, length, agree: agreeHit || null, strong,
      }, hints);
    }
    return Object.assign({ kind: 'none', reason: '', score: Math.max(docScore, consentScore), context, termsLinks, density, length, agree: agreeHit || null, strong }, hints);
  }

  /** Najde odkazy, které vedou na dokumenty s podmínkami. */
  function findTermsLinks(links, baseUrl) {
    const out = [];
    const seen = new Set();
    for (const l of links) {
      if (!l || !l.href) continue;
      let abs;
      try { abs = new URL(l.href, baseUrl).href; } catch (e) { continue; }
      if (!/^https?:/i.test(abs)) continue;
      const textN = normalize(l.text);
      const tHit = containsAny(textN, TITLES_N);
      const uHit = urlLooksLikeTerms(abs);
      // Krátké texty typu „VOP“, „GDPR“, „Terms“
      const shortHit = /^(vop|gdpr|terms|tos|eula|agb|podminky|podmienky|soukromi|privacy|legal)$/.test(textN) ? textN : null;
      if (!tHit && !uHit && !shortHit) continue;
      const key = abs.replace(/#.*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url: key,
        text: (l.text || '').trim().slice(0, 120),
        type: classifyLink(textN + ' ' + normalize(abs)),
        weight: (tHit ? 2 : 0) + (uHit ? 1 : 0) + (shortHit ? 1 : 0),
      });
    }
    out.sort((a, b) => b.weight - a.weight);
    return out.slice(0, 6);
  }

  function classifyLink(sN) {
    if (/(privacy|soukromi|osobni|osobnich|gdpr|datenschutz|cookie)/.test(sN)) return 'soukromi';
    if (/(eula|licen|lizenz)/.test(sN)) return 'licence';
    if (/(reklama|refund|return|widerruf)/.test(sN)) return 'reklamace';
    return 'podminky';
  }

  const API = { detect, findTermsLinks, normalize, urlLooksLikeTerms, legalDensity };
  root.TermsDetector = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
