/*
 * JSON schéma výsledku analýzy. Používá ho volání Claude API (strukturovaný výstup)
 * i offline analyzátor, aby popup a overlay dostaly vždy stejný tvar.
 */
(function (root) {
  'use strict';

  const FINDING = {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['kriticke', 'varovne', 'info'] },
      category: { type: 'string', enum: ['data', 'treti_strany', 'platby', 'zruseni', 'prava', 'odpovednost', 'jine'] },
      title: { type: 'string', description: 'Krátký nadpis nálezu (česky).' },
      detail: { type: 'string', description: 'Co to pro uživatele znamená, 1–3 věty česky.' },
      quote: { type: 'string', description: 'Doslovná citace z dokumentu (max. 300 znaků) nebo prázdný řetězec.' },
    },
    required: ['severity', 'category', 'title', 'detail', 'quote'],
    additionalProperties: false,
  };

  const PRICE = {
    type: 'object',
    properties: {
      item: { type: 'string', description: 'Za co se platí (např. „Předplatné Premium“, „Doprava“, „Storno poplatek“).' },
      amount: { type: 'string', description: 'Částka tak, jak je uvedena, např. „199 Kč“, „9,99 €“.' },
      period: { type: 'string', description: 'měsíčně / ročně / jednorázově / za kus / neuvedeno' },
      note: { type: 'string', description: 'Doplňující podmínka (např. „po skončení 7denní zkušební verze“).' },
    },
    required: ['item', 'amount', 'period', 'note'],
    additionalProperties: false,
  };

  const RESULT_SCHEMA = {
    type: 'object',
    properties: {
      document_type: { type: 'string', description: 'Typ dokumentu, např. „obchodní podmínky e-shopu“, „zásady ochrany osobních údajů“, „EULA“.' },
      language: { type: 'string', description: 'Jazyk dokumentu (kód, např. cs, en, de).' },
      verdict: { type: 'string', enum: ['standardni', 'pozor', 'nebezpecne'], description: 'Celkové hodnocení.' },
      risk_score: { type: 'integer', description: 'Rizikovost 0 (bez rizika) až 100 (velmi rizikové).' },
      is_standard: { type: 'boolean', description: 'Zda jde o běžný, standardní text bez neobvyklých ustanovení.' },
      summary: { type: 'string', description: 'Srozumitelné shrnutí pro laika, 2–5 vět česky.' },
      findings: { type: 'array', items: FINDING, description: 'Konkrétní nálezy seřazené od nejzávažnějšího.' },
      data_sharing: {
        type: 'object',
        properties: {
          shares_with_third_parties: { type: 'boolean' },
          parties: { type: 'array', items: { type: 'string' }, description: 'S kým se údaje sdílejí (kategorie nebo jména).' },
          purposes: { type: 'array', items: { type: 'string' }, description: 'Za jakým účelem.' },
          transfers_outside_eu: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['shares_with_third_parties', 'parties', 'purposes', 'transfers_outside_eu', 'detail'],
        additionalProperties: false,
      },
      cancellation: {
        type: 'object',
        properties: {
          found: { type: 'boolean', description: 'Zda dokument popisuje, jak zrušit smlouvu / předplatné / vrátit zboží.' },
          how: { type: 'string', description: 'Jak zrušit – konkrétní postup česky, nebo „neuvedeno“.' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Kroky ke zrušení, pokud se dají vyčíst.' },
          notice_period: { type: 'string', description: 'Výpovědní lhůta / lhůta pro odstoupení, nebo „neuvedeno“.' },
          auto_renewal: { type: 'boolean', description: 'Zda se smlouva/předplatné automaticky prodlužuje.' },
          penalties: { type: 'string', description: 'Sankce či poplatky za zrušení, nebo „žádné uvedeny“.' },
          refund: { type: 'string', description: 'Podmínky vrácení peněz, nebo „neuvedeno“.' },
        },
        required: ['found', 'how', 'steps', 'notice_period', 'auto_renewal', 'penalties', 'refund'],
        additionalProperties: false,
      },
      prices: { type: 'array', items: PRICE, description: 'Všechny ceny, poplatky a částky zmíněné v dokumentu.' },
      key_points: { type: 'array', items: { type: 'string' }, description: '3–7 nejdůležitějších bodů v jedné větě každý.' },
    },
    required: ['document_type', 'language', 'verdict', 'risk_score', 'is_standard', 'summary', 'findings', 'data_sharing', 'cancellation', 'prices', 'key_points'],
    additionalProperties: false,
  };

  const API = { RESULT_SCHEMA, FINDING, PRICE };
  root.TermsSchema = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
