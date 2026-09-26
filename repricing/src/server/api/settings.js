'use strict';
// API: nastavení (SPEC §8). POST /api/v1/settings/password obsluhuje api/auth.js.
//
//   GET /api/v1/settings   read   → getSettings(db) (nikdy klíče začínající „_“)
//                                  Bez rozsahu admin jsou hodnoty hlaviček webhooku skryté („***“) – mohou nést tajemství.
//   PUT /api/v1/settings   admin  částečný objekt nastavení → deep-merge s aktuálním stavem → validace → uložení
//                                  po klíčích nejvyšší úrovně (setSetting) → getSettings(db)
//
// Pravidla PUT:
//  - neznámé klíče (i vnořené) a klíče „_…“ → 400 (překlep by se jinak tiše ignoroval),
//  - pole (export.xml.fields, …) se nahrazují celá, objekty se slučují,
//  - export.webhook.headers: hodnota null hlavičku odstraní (deep-merge jinak klíče mazat neumí),
//  - ukládá se jen klíč nejvyšší úrovně, jehož výsledná hodnota se změnila.

const { getSettings, setSetting, deepMerge, DEFAULT_SETTINGS, tx } = require('../../db');
const { ROW_FIELDS } = require('../../export/rows');
const { HttpError } = require('../http');
const { hasScope } = require('../auth');
const V = require('./_views');

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const isXmlName = (s) => typeof s === 'string' && XML_NAME.test(s) && !/^xml/i.test(s);

/** Validátory hodnot podle cesty; vrací text chyby nebo null. */
const isBool = (v) => (typeof v === 'boolean' ? null : 'musí být ano/ne (true/false)');
const num = ({ min = -Infinity, max = Infinity, integer = false } = {}) => (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'musí být číslo';
  if (integer && !Number.isInteger(v)) return 'musí být celé číslo';
  if (v < min || v > max) return `musí být v rozsahu ${min}–${max}`;
  return null;
};
const oneOf = (...vals) => (v) => (vals.includes(v) ? null : `musí být jedna z hodnot: ${vals.join(', ')}`);
const text = ({ max = 200, re = null, reMsg = '' } = {}) => (v) => {
  if (typeof v !== 'string') return 'musí být text';
  if (v.length > max) return `je příliš dlouhé (max. ${max} znaků)`;
  if (re && v !== '' && !re.test(v)) return reMsg;
  return null;
};

const SCHEMA = {
  currency: text({ max: 3, re: /^[A-Z]{3}$/, reMsg: 'musí být kód měny ISO 4217 (např. CZK)' }),
  vat_rate_default: num({ min: 0, max: 99 }),
  purchase_includes_vat: isBool,
  offer_max_age_days: num({ min: 0, max: 3650 }),
  metrics_in_stock_only: isBool,
  export: {
    update_current_price: isBool,
    xml: {
      root: (v) => (isXmlName(v) ? null : 'musí být platný název XML elementu (písmena, číslice, _ . -, nesmí začínat číslicí ani „xml“)'),
      item: (v) => (isXmlName(v) ? null : 'musí být platný název XML elementu (písmena, číslice, _ . -, nesmí začínat číslicí ani „xml“)'),
      fields: (v) => {
        if (Array.isArray(v)) {
          if (!v.length) return 'musí obsahovat aspoň jedno pole';
          const bad = v.filter((f) => !ROW_FIELDS.includes(f));
          return bad.length ? `neznámá pole ${bad.map((b) => `„${b}“`).join(', ')} (povoleno: ${ROW_FIELDS.join(', ')})` : null;
        }
        if (V.isPlainObject(v)) {
          const keys = Object.keys(v);
          if (!keys.length) return 'musí obsahovat aspoň jedno pole';
          const bad = keys.filter((f) => !ROW_FIELDS.includes(f));
          if (bad.length) return `neznámá pole ${bad.map((b) => `„${b}“`).join(', ')} (povoleno: ${ROW_FIELDS.join(', ')})`;
          const badNames = Object.values(v).filter((n) => n != null && n !== '' && n !== true && !isXmlName(n));
          return badNames.length ? `neplatné názvy XML elementů: ${badNames.map((b) => `„${b}“`).join(', ')}` : null;
        }
        return 'musí být seznam polí nebo objekt {pole: element}';
      },
    },
    pohoda: {
      ico: text({ max: 12, re: /^\d+$/, reMsg: 'IČO smí obsahovat jen číslice' }),
      application: text({ max: 100 }),
      filter_by: oneOf('code', 'ean'),
      price_level: text({ max: 50 }),
      price_level_includes_vat: isBool,
      encoding: oneOf('windows-1250', 'utf-8'),
    },
    webhook: {
      url: (v) => {
        if (typeof v !== 'string') return 'musí být text';
        if (v === '') return null;
        let u;
        try {
          u = new URL(v);
        } catch {
          return 'není platná URL';
        }
        return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'musí začínat http:// nebo https://';
      },
      format: oneOf('json', 'xml', 'csv'),
      headers: (v) => {
        if (!V.isPlainObject(v)) return 'musí být objekt {název: hodnota}';
        for (const [k, val] of Object.entries(v)) {
          if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) return `neplatný název hlavičky „${k}“`;
          if (typeof val !== 'string') return `hodnota hlavičky „${k}“ musí být text`;
          if (/[\r\n]/.test(val)) return `hodnota hlavičky „${k}“ nesmí obsahovat konec řádku`;
        }
        return null;
      },
      auto_push: isBool,
      timeout_ms: num({ min: 1000, max: 300000, integer: true }),
    },
  },
  schedule: {
    run_interval_minutes: num({ min: 0, max: 10080, integer: true }),
    run_after_import: isBool,
    auto_push_after_run: isBool,
  },
  retention_days: num({ min: 0, max: 36500, integer: true }),
  retention_superseded_days: num({ min: 1, max: 36500, integer: true }),
};

const LABELS = {
  currency: 'Měna',
  vat_rate_default: 'Výchozí sazba DPH',
  purchase_includes_vat: 'Nákupní ceny s DPH',
  offer_max_age_days: 'Maximální stáří nabídek (dny)',
  metrics_in_stock_only: 'Metriky jen z nabídek skladem',
  retention_days: 'Doba uchování dat (dny)',
  retention_superseded_days: 'Doba uchování nahrazených návrhů (dny)',
};

/** Projde (sloučený) objekt podle schématu; neznámé klíče v těle hlásí zvlášť. */
function validate(value, schema, path, errors) {
  for (const [k, rule] of Object.entries(schema)) {
    const p = path ? `${path}.${k}` : k;
    const v = value ? value[k] : undefined;
    if (typeof rule === 'function') {
      const err = v === undefined ? 'chybí hodnota' : rule(v);
      if (err) errors.push(`${LABELS[p] ? `${LABELS[p]} (${p})` : p}: ${err}`);
    } else if (!V.isPlainObject(v)) {
      errors.push(`${p}: musí být objekt`);
    } else {
      validate(v, rule, p, errors);
    }
  }
}

function unknownKeys(body, schema, path, out) {
  for (const k of Object.keys(body)) {
    const p = path ? `${path}.${k}` : k;
    if (k.startsWith('_')) {
      out.push(`${p}: interní nastavení nelze měnit přes API`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(schema, k)) {
      out.push(`${p}: neznámé nastavení`);
      continue;
    }
    const rule = schema[k];
    if (typeof rule !== 'function' && V.isPlainObject(body[k])) unknownKeys(body[k], rule, p, out);
  }
}

/** Hodnoty hlaviček webhooku skryté pro volající bez rozsahu admin. */
function maskSecrets(settings, scopes) {
  if (hasScope(scopes, 'admin')) return settings;
  const out = structuredClone(settings);
  const h = out.export && out.export.webhook && out.export.webhook.headers;
  if (V.isPlainObject(h)) for (const k of Object.keys(h)) h[k] = '***';
  return out;
}

function putSettings(ctx) {
  const db = ctx.db;
  const body = V.bodyObject(ctx);
  const unknown = [];
  unknownKeys(body, SCHEMA, '', unknown);
  if (unknown.length) throw new HttpError(400, `Neplatné nastavení: ${unknown.join('; ')}`, unknown);
  const current = getSettings(db);
  const merged = deepMerge(current, body);
  const headers = merged.export && merged.export.webhook && merged.export.webhook.headers;
  if (V.isPlainObject(headers)) {
    const clean = {};
    for (const [k, v] of Object.entries(headers)) if (v !== null && v !== undefined) clean[k] = v;
    merged.export = { ...merged.export, webhook: { ...merged.export.webhook, headers: clean } };
  }
  const errors = [];
  validate(merged, SCHEMA, '', errors);
  if (errors.length) throw new HttpError(400, `Neplatné nastavení: ${errors.join('; ')}`, errors);
  const changed = [];
  tx(db, () => {
    for (const k of Object.keys(body)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      if (JSON.stringify(merged[k]) === JSON.stringify(current[k])) continue;
      setSetting(db, k, merged[k]);
      changed.push(k);
    }
  });
  if (changed.length) {
    ctx.audit({ action: 'settings.update', entity: 'settings', detail: { keys: changed } });
    V.invalidate(db, 'views');
  }
  return getSettings(db);
}

module.exports = {
  register(router) {
    router.get('/api/v1/settings', (ctx) => maskSecrets(getSettings(ctx.db), ctx.scopes), { auth: 'read' });
    router.put('/api/v1/settings', putSettings, { auth: 'admin' });
  },
  SCHEMA,
};
