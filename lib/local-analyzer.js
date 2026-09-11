/*
 * Offline heuristická analýza – běží bez API klíče přímo v prohlížeči.
 * Nedosahuje kvality jazykového modelu, ale spolehlivě vytáhne ceny, věty o zrušení,
 * automatické prodlužování a nejčastější rizikové formulace.
 * Vrací objekt ve stejném tvaru jako RESULT_SCHEMA (lib/schema.js).
 */
(function (root) {
  'use strict';

  const K = root.TermsKeywords || (typeof require === 'function' ? require('./keywords.js') : null);

  const SEVERITY_WEIGHT = { kriticke: 22, varovne: 9, info: 2 };

  function splitSentences(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .split(/(?<=[.!?;])\s+(?=[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9„"(])|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15);
  }

  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function detectLanguage(text) {
    const t = text.slice(0, 5000).toLowerCase();
    const cs = (t.match(/[ěščřžýáíéůú]/g) || []).length + (t.match(/\b(a|je|se|na|že|pro|nebo|podmínky|uživatel)\b/g) || []).length;
    const sk = (t.match(/[ľĺŕôä]/g) || []).length * 3 + (t.match(/\b(alebo|ktoré|podmienky|používateľ)\b/g) || []).length * 2;
    const de = (t.match(/\b(und|der|die|das|nicht|oder|nutzer|vertrag)\b/g) || []).length;
    const en = (t.match(/\b(the|and|you|your|shall|terms|service|agree)\b/g) || []).length;
    const best = Math.max(cs, sk, de, en);
    if (best === 0) return 'neznámý';
    if (best === sk && sk > cs) return 'sk';
    if (best === cs) return 'cs';
    if (best === de) return 'de';
    return 'en';
  }

  function classifyDocument(text) {
    const head = text.slice(0, 400).toLowerCase();
    if (/(obchodní podmínky|obchodné podmienky|terms of (service|use|sale)|terms and conditions|geschäftsbedingungen|nutzungsbedingungen)/.test(head)) {
      return /(e-?shop|zboží|objednáv|goods|order)/.test(text.slice(0, 3000).toLowerCase()) ? 'obchodní podmínky e-shopu' : 'obchodní podmínky / podmínky užití';
    }
    if (/(ochran\w+ osobních údajů|zásady zpracování|privacy (policy|notice)|datenschutz)/.test(head)) return 'zásady ochrany osobních údajů';
    if (/(licenční|licence agreement|license agreement|eula|lizenz)/.test(head)) return 'licenční ujednání (EULA)';
    const t = text.slice(0, 3000).toLowerCase();
    if (/(osobní\w*\s+údaj|osobn\w+\s+údaj|personal data|privacy|datenschutz|gdpr)/.test(t) && !/(obchodní podmínky|terms of (service|use))/.test(t)) return 'zásady ochrany osobních údajů';
    if (/(licen[cč]|eula|end.user|lizenz)/.test(t)) return 'licenční ujednání (EULA)';
    if (/(předplatn|subscription|abonnement)/.test(t)) return 'podmínky předplatného';
    if (/(cookie)/.test(t)) return 'zásady používání cookies';
    if (/(reklama|refund|return policy|widerruf)/.test(t)) return 'reklamační / vratkový řád';
    if (/(e-?shop|objednávk|kupující|zboží|order|goods|purchase)/.test(t)) return 'obchodní podmínky e-shopu';
    return 'obchodní podmínky / podmínky užití';
  }

  function findRisks(sentences) {
    const findings = [];
    const seen = new Set();
    for (const group of K.RISK_GROUPS) {
      let bestSentence = null;
      let hits = 0;
      for (const s of sentences) {
        if (group.patterns.some((re) => re.test(s))) {
          hits++;
          if (!bestSentence || (s.length < bestSentence.length && s.length > 40)) bestSentence = s;
          if (hits >= 3) break;
        }
      }
      if (!hits || seen.has(group.id)) continue;
      seen.add(group.id);
      findings.push({
        severity: group.severity,
        category: group.category,
        title: group.title,
        detail: explain(group.id),
        quote: clip(bestSentence, 300),
        _hits: hits,
      });
    }
    const order = { kriticke: 0, varovne: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || b._hits - a._hits);
    return findings;
  }

  function explain(id) {
    switch (id) {
      case 'sdileni_treti_strany': return 'Dokument připouští předání vašich údajů dalším firmám. Zjistěte komu a proč – běžné je předání dopravci nebo platební bráně, podezřelé jsou „obchodní partneři“ bez upřesnění.';
      case 'prodej_udaju': return 'Text naznačuje, že vaše údaje mohou být prodány nebo zpeněženy. To je nadstandardně rizikové ustanovení.';
      case 'prenos_mimo_eu': return 'Údaje mohou opustit EU (typicky do USA). Ochrana je pak slabší, pokud nejsou uvedeny záruky (standardní smluvní doložky).';
      case 'marketing_profilovani': return 'Vaše chování může být sledováno, profilováno nebo použito k cílené reklamě. Zkontrolujte, zda jde odmítnout.';
      case 'citlive_udaje': return 'Zpracovávají se citlivé údaje nebo přístup k poloze, kontaktům, kameře či dokladům. Zvažte, zda je to pro službu skutečně nutné.';
      case 'automaticke_prodlouzeni': return 'Smlouva nebo předplatné se samo prodlužuje a platby se opakují, dokud je aktivně nezrušíte. Poznamenejte si, dokdy je třeba zrušit.';
      case 'zkusebni_obdobi': return 'Bezplatná zkušební verze po uplynutí přejde v placenou. Bez zrušení vám bude účtována plná cena.';
      case 'sankce_poplatky': return 'Za zrušení, vrácení nebo prodlení mohou být účtovány pokuty nebo poplatky.';
      case 'zmena_cen': return 'Poskytovatel si vyhrazuje právo měnit ceny. Ověřte, zda vás musí předem informovat a zda můžete odstoupit.';
      case 'jednostranna_zmena': return 'Podmínky lze měnit jednostranně, případně bez upozornění. Sledujte změny, nebo si nastavte upozornění.';
      case 'licence_obsah': return 'Poskytovateli dáváte širokou (často neodvolatelnou a celosvětovou) licenci k vašemu obsahu, nebo se vzdáváte některých práv.';
      case 'rozhodci_soud': return 'Spory se mohou řešit rozhodčím řízením nebo podle cizího práva, což může ztížit obranu vašich práv.';
      case 'vylouceni_odpovednosti': return 'Poskytovatel omezuje svou odpovědnost za škody. U spotřebitelů je to často jen v mezích zákona, ale ověřte rozsah.';
      case 'ukonceni_uctu': return 'Váš účet může být zrušen nebo zablokován kdykoli, někdy bez udání důvodu a bez náhrady.';
      case 'sledovani_deti': return 'Dokument řeší nezletilé uživatele – relevantní, pokud službu používají děti.';
      case 'uchovavani_udaju': return 'Uvádí se, jak dlouho jsou vaše údaje uchovávány.';
      default: return '';
    }
  }

  function findPrices(text) {
    const out = [];
    const seen = new Set();
    const re = new RegExp(K.CURRENCY_RE.source, 'gi');
    let m;
    while ((m = re.exec(text)) !== null && out.length < 40) {
      const amount = m[0].replace(/\s+/g, ' ').trim();
      // vyhoď čísla bez měny typu „14 dní“ – regex vyžaduje měnu, ale pro jistotu:
      if (!/[a-z€$£]|,-/i.test(amount)) continue;
      const start = Math.max(0, m.index - 90);
      const end = Math.min(text.length, m.index + amount.length + 90);
      const ctx = text.slice(start, end).replace(/##\s*/g, '').replace(/\s+/g, ' ');
      // Období hledáme nejdřív těsně za částkou („199 Kč měsíčně“), pak těsně před ní, až pak v širším okolí.
      const after = text.slice(m.index + amount.length, m.index + amount.length + 28);
      const before = text.slice(Math.max(0, m.index - 28), m.index);
      let period = 'neuvedeno';
      for (const win of [after, before, ctx]) {
        for (const p of K.PERIOD_PATTERNS) if (p.re.test(win)) { period = p.period; break; }
        if (period !== 'neuvedeno') break;
      }
      let kind = 'částka';
      for (const p of K.PRICE_KIND_PATTERNS) if (p.re.test(ctx)) { kind = p.kind; break; }
      const key = amount.toLowerCase() + '|' + period + '|' + kind;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ item: kind, amount, period, note: clip(ctx, 160) });
    }
    return out;
  }

  function findCancellation(sentences) {
    const cancelSentences = sentences.filter((s) => K.CANCELLATION_PATTERNS.some((re) => re.test(s)));
    const autoRenewal = sentences.some((s) => K.AUTO_RENEWAL_PATTERNS.some((re) => re.test(s)));
    let noticePeriod = 'neuvedeno';
    for (const s of sentences) {
      for (const re of K.NOTICE_PERIOD_PATTERNS) {
        const m = s.match(re);
        if (m) { noticePeriod = clip(m[0], 120); break; }
      }
      if (noticePeriod !== 'neuvedeno') break;
    }
    // Lhůta 14 dní pro odstoupení (spotřebitel v EU)
    if (noticePeriod === 'neuvedeno') {
      const w = sentences.find((s) => /(14|čtrnácti?)\s*(dní|dnů|days?|tag)/i.test(s) && /(odstoup|withdraw|widerruf|vrátit|return)/i.test(s));
      if (w) noticePeriod = '14 dní na odstoupení od smlouvy (viz citace)';
    }
    const how = [];
    for (const s of cancelSentences) {
      for (const re of K.CANCEL_HOW_PATTERNS) {
        const m = s.match(re);
        if (m) { how.push(clip(m[0], 140)); break; }
      }
      if (how.length >= 4) break;
    }
    const penalties = sentences.find((s) => /(storno|pokut|poplat|fee|penalt|nevratn|non-refundable)/i.test(s) && /(zruš|ukonč|odstoup|cancel|terminat|withdraw|vrácen|refund)/i.test(s));
    const refund = sentences.find((s) => /(vrácen\w+\s+(peněz|platby|kupní ceny)|vrátíme|refund|money[- ]back|erstattung)/i.test(s));
    const steps = cancelSentences.slice(0, 5).map((s) => clip(s, 220));
    return {
      found: cancelSentences.length > 0,
      how: how.length ? [...new Set(how)].join('; ') : (cancelSentences.length ? 'Postup viz citované věty níže.' : 'neuvedeno'),
      steps,
      notice_period: noticePeriod,
      auto_renewal: autoRenewal,
      penalties: penalties ? clip(penalties, 220) : 'žádné uvedeny',
      refund: refund ? clip(refund, 220) : 'neuvedeno',
    };
  }

  function findDataSharing(sentences, findings) {
    const sharing = findings.filter((f) => f.category === 'treti_strany');
    const partyRe = /(google|facebook|meta|microsoft|amazon|apple|stripe|paypal|gopay|comgate|adyen|braintree|hotjar|mailchimp|ecomail|smartemailing|zásilkovna|packeta|ppl|dpd|gls|česká pošta|dhl|ups|heureka|zboží\.cz|seznam|tiktok|linkedin|twitter|x corp|cloudflare|aws|salesforce|hubspot|zendesk|intercom|sentry|mixpanel|amplitude|analytics|adwords|ads|dopravc\w+|platební\w*\s+brán\w*|payment (provider|processor)|účetn\w+|advokát\w+|inkasn\w+|collection agenc\w+)/gi;
    const parties = new Set();
    const purposes = new Set();
    for (const s of sentences) {
      if (!/(třetí|tretí|third|partner|zpracovatel|processor|příjemc|recipient|dopravc|carrier|platebn|payment|dritte|empfänger)/i.test(s)) continue;
      let m;
      const re = new RegExp(partyRe.source, 'gi');
      while ((m = re.exec(s)) !== null && parties.size < 15) parties.add(m[0].toLowerCase());
      if (/(doručen|doprav|delivery|shipping)/i.test(s)) purposes.add('doručení zboží');
      if (/(platb|payment|zaplacen)/i.test(s)) purposes.add('zpracování platby');
      if (/(marketing|reklam|advertis|newsletter|obchodní sdělení)/i.test(s)) purposes.add('marketing a reklama');
      if (/(analy|statisti|měřen|tracking|sledov)/i.test(s)) purposes.add('analytika a měření');
      if (/(právn|legal|soud|court|úřad|authorit|zákon|law)/i.test(s)) purposes.add('plnění zákonných povinností');
      if (/(účetn|accounting|daňov|tax)/i.test(s)) purposes.add('účetnictví');
      if (/(hosting|cloud|server|úložišt|storage)/i.test(s)) purposes.add('hosting a technická infrastruktura');
    }
    const outsideEu = findings.some((f) => f.title.includes('mimo EU'));
    return {
      shares_with_third_parties: sharing.length > 0 || parties.size > 0,
      parties: [...parties],
      purposes: [...purposes],
      transfers_outside_eu: outsideEu,
      detail: sharing.length
        ? sharing.map((f) => f.title).join('; ')
        : (parties.size ? 'Dokument jmenuje konkrétní příjemce údajů (viz seznam).' : 'Nenalezena zmínka o předávání údajů třetím stranám.'),
    };
  }

  function score(findings, cancellation) {
    let s = 0;
    for (const f of findings) s += SEVERITY_WEIGHT[f.severity] || 0;
    if (cancellation.auto_renewal && cancellation.how === 'neuvedeno') s += 10;
    if (!cancellation.found) s += 5;
    return Math.max(0, Math.min(100, s));
  }

  function analyze(text, meta) {
    text = String(text || '');
    const sentences = splitSentences(text);
    const findings = findRisks(sentences);
    const cancellation = findCancellation(sentences);
    const prices = findPrices(text);
    const dataSharing = findDataSharing(sentences, findings);
    const riskScore = score(findings, cancellation);
    const verdict = riskScore >= 45 ? 'nebezpecne' : riskScore >= 18 ? 'pozor' : 'standardni';
    const criticals = findings.filter((f) => f.severity === 'kriticke');
    const warnings = findings.filter((f) => f.severity === 'varovne');

    const summaryParts = [];
    summaryParts.push(
      verdict === 'standardni'
        ? 'Text vypadá jako běžné podmínky bez výrazně neobvyklých ustanovení.'
        : verdict === 'pozor'
          ? 'Podmínky obsahují několik ustanovení, která stojí za pozornost.'
          : 'Podmínky obsahují ustanovení, která jsou pro vás potenciálně nevýhodná nebo riziková.'
    );
    if (criticals.length) summaryParts.push('Kritické: ' + criticals.map((f) => f.title.toLowerCase()).join(', ') + '.');
    if (warnings.length) summaryParts.push('Varování: ' + warnings.slice(0, 4).map((f) => f.title.toLowerCase()).join(', ') + '.');
    if (cancellation.auto_renewal) summaryParts.push('Předplatné se automaticky prodlužuje.');
    if (prices.length) summaryParts.push('Nalezeno ' + prices.length + ' cenových údajů.');
    summaryParts.push('(Rychlá offline analýza – pro přesnější rozbor zadejte v nastavení API klíč.)');

    const keyPoints = [];
    for (const f of findings.slice(0, 5)) keyPoints.push(f.title + ' – ' + clip(f.detail.split('.')[0], 120) + '.');
    if (cancellation.found) keyPoints.push('Zrušení: ' + clip(cancellation.how, 140));
    if (prices.length) keyPoints.push('Ceny: ' + prices.slice(0, 3).map((p) => p.amount + (p.period !== 'neuvedeno' ? ' ' + p.period : '')).join(', '));

    return {
      document_type: classifyDocument(text),
      language: detectLanguage(text),
      verdict,
      risk_score: riskScore,
      is_standard: verdict === 'standardni',
      summary: summaryParts.join(' '),
      findings: findings.map(({ _hits, ...f }) => f),
      data_sharing: dataSharing,
      cancellation,
      prices,
      key_points: keyPoints,
      _engine: 'local',
      _meta: meta || {},
    };
  }

  const API = { analyze, splitSentences, findPrices, findCancellation, findRisks, detectLanguage };
  root.TermsLocalAnalyzer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
