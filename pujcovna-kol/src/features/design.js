'use strict';
// Feature „design“ (jen PK_DEMO=1): /design – galerie všech komponent s ukázkovým obsahem ve zvoleném tématu,
// popis tří designů ze src/themes.js, přepínač, odkaz na /admin s poznámkou o demo přístupu.
// /design/nastavit?design=sport&zpet=/kola → ověří hodnotu proti seznamu témat, zpet jen relativní cesta,
// nastaví cookie __Host-pk_design (30 dní, HttpOnly, SameSite=Lax, Secure za proxy/https) a vrátí 302.
// Vstup: ctx. Výstup: stránka / redirect.

const { isTheme, THEMES } = require('../themes');
const page = require('../render/pages/design');

const DESIGN_COOKIE = '__Host-pk_design';
const COOKIE_DAYS = 30;

async function galleryHandler(ctx) {
  ctx.render(
    page.design,
    { tenant: ctx.tenant, theme: ctx.theme, themes: THEMES, csrf: ctx.csrfToken(), settings: ctx.settings },
    { title: 'Design a komponenty', description: 'Ukázka tří designů musteru a všech komponent uživatelského rozhraní.', feature: 'design', noindex: true }
  );
}

async function setHandler(ctx) {
  const design = ctx.query.design;
  const back = ctx.safePath(ctx.query.zpet, '/');
  if (!isTheme(design)) {
    ctx.log.warn('Neplatný design v přepínači');
    return ctx.redirect(back, 302);
  }
  ctx.setCookie(DESIGN_COOKIE, design, { maxAgeSec: COOKIE_DAYS * 24 * 3600, httpOnly: true, sameSite: 'Lax', secure: ctx.secure || /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(ctx.req.headers.host || '')) });
  // „zpet“ může nést ?design= z předchozí stránky – odstranit, aby nepřebil cookie
  let target = back;
  try {
    const u = new URL(back, 'http://localhost');
    u.searchParams.delete('design');
    target = u.pathname + (u.search || '') + (u.hash || '');
  } catch {
    target = '/';
  }
  return ctx.redirect(target, 302);
}

module.exports = {
  name: 'design',
  demoOnly: true,
  routes: [
    ['GET', '/design', galleryHandler, { rateLimit: 'public' }],
    ['GET', '/design/nastavit', setHandler, { rateLimit: 'public' }],
  ],
  nav: [{ label: 'Design', href: '/design', order: 95 }],
  css: ['/css/design.css'],
  js: [],
  DESIGN_COOKIE,
};
