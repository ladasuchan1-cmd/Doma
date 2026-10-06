'use strict';
// Tenanty: načtení tenants/*/tenant.json, výběr tenanta podle hlavičky Host, téma podle hostu,
// kopie výchozích settings do tabulky settings při prvním startu (SPEC kap. 3 a 5).
// Vstup: adresář tenantů (config.tenantsDir). Výstup: pole tenantů { slug, dir, file, ...tenant.json }.

const fs = require('node:fs');
const path = require('node:path');
const { isTheme, DEFAULT_THEME } = require('./themes');
const { getSetting, setSetting } = require('./db');

const REQUIRED_KEYS = ['slug', 'name', 'hosts'];

/** Načte a zvaliduje jeden tenant.json. */
function loadTenant(dir) {
  const file = path.join(dir, 'tenant.json');
  const tenant = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of REQUIRED_KEYS) {
    if (tenant[k] === undefined) throw new Error(`${file}: chybí povinný klíč „${k}“`);
  }
  if (!Array.isArray(tenant.hosts) || !tenant.hosts.length) throw new Error(`${file}: hosts musí být neprázdné pole`);
  if (tenant.slug !== path.basename(dir)) throw new Error(`${file}: slug „${tenant.slug}“ neodpovídá názvu složky „${path.basename(dir)}“`);
  if (tenant.themeDefault && !isTheme(tenant.themeDefault)) throw new Error(`${file}: neznámé téma „${tenant.themeDefault}“`);
  return {
    ...tenant,
    hosts: tenant.hosts.map((h) => normalizeHost(h)),
    themeDefault: tenant.themeDefault || DEFAULT_THEME,
    themeByHost: Object.fromEntries(Object.entries(tenant.themeByHost || {}).map(([h, t]) => [normalizeHost(h), t])),
    settings: tenant.settings || {},
    brand: tenant.brand || {},
    business: tenant.business || {},
    location: tenant.location || null,
    openingHours: tenant.openingHours || {},
    legal: tenant.legal || {},
    texts: tenant.texts || {},
    dir,
    file,
  };
}

/** Načte všechny tenanty z adresáře (podsložky s tenant.json). */
function loadTenants(tenantsDir) {
  let entries;
  try {
    entries = fs.readdirSync(tenantsDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Adresář tenantů ${tenantsDir} nelze číst: ${e.message}`);
  }
  const tenants = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(tenantsDir, ent.name);
    if (!fs.existsSync(path.join(dir, 'tenant.json'))) continue;
    tenants.push(loadTenant(dir));
  }
  if (!tenants.length) throw new Error(`V ${tenantsDir} není žádný tenant (tenants/<slug>/tenant.json).`);
  const seen = new Map();
  for (const t of tenants) {
    for (const h of t.hosts) {
      if (seen.has(h)) throw new Error(`Host „${h}“ je přiřazen dvěma tenantům (${seen.get(h)}, ${t.slug}).`);
      seen.set(h, t.slug);
    }
  }
  return tenants;
}

/** Host bez portu, lowercase, IDN beze změny. */
function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  // IPv6 [::1]:port
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1];
  const colon = h.indexOf(':');
  if (colon >= 0) h = h.slice(0, colon);
  return h;
}

/**
 * Najde tenant podle hostu. Neznámý host → v demo režimu tenant „demo“ (nebo první), jinak null.
 * @param {object[]} tenants
 * @param {string} hostHeader hodnota hlavičky Host
 * @param {{demo?: boolean}} [opts]
 */
function resolveTenant(tenants, hostHeader, { demo = false } = {}) {
  const host = normalizeHost(hostHeader);
  const found = tenants.find((t) => t.hosts.includes(host));
  if (found) return found;
  if (demo) return tenants.find((t) => t.slug === 'demo') || tenants[0] || null;
  return null;
}

/** Téma podle hostu: themeByHost[host] || themeDefault. */
function themeForHost(tenant, hostHeader) {
  const host = normalizeHost(hostHeader);
  const t = tenant.themeByHost && tenant.themeByHost[host];
  return isTheme(t) ? t : tenant.themeDefault || DEFAULT_THEME;
}

/** Při prvním startu zkopíruje tenant.settings do tabulky settings (existující klíče nepřepisuje). Vrací počet vložených. */
function seedSettings(db, tenant) {
  let inserted = 0;
  const now = new Date().toISOString();
  const stmt = db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [key, value] of Object.entries(tenant.settings || {})) {
    inserted += Number(stmt.run(key, JSON.stringify(value), now).changes);
  }
  return inserted;
}

/** Efektivní nastavení: výchozí z tenant.json přepsané hodnotami z tabulky settings. */
function getSettings(db, tenant) {
  const out = { ...(tenant.settings || {}) };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* poškozená hodnota → ponechat výchozí */
    }
  }
  return out;
}

/**
 * Veřejná URL tenanta pro canonical a JSON-LD, např. https://ksprehledy.cz. Bez hostu první nelokální host.
 * Nelokální hosty mají vždy https (veřejně běží jen za TLS proxy); localhost/127.0.0.1 http, pokud požadavek nebyl https.
 */
function publicBaseUrl(tenant, { host, secure = false } = {}) {
  const h = host ? normalizeHost(host) : tenant.hosts.find((x) => x !== 'localhost' && x !== '127.0.0.1') || tenant.hosts[0];
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1';
  const scheme = secure || !isLocal ? 'https' : 'http';
  return `${scheme}://${host ? String(host).trim().toLowerCase() : h}`;
}

module.exports = { loadTenants, loadTenant, normalizeHost, resolveTenant, themeForHost, seedSettings, getSettings, getSetting, setSetting, publicBaseUrl };
