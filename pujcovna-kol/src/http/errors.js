'use strict';
// Chyby HTTP (SPEC kap. 3): HttpError (status + česká zpráva), stránky 404 / 500 (a další stavy) v layoutu tématu
// bez stack trace; 500 zaloguje chybu s request id a uživatel vidí jen id.
// Vstup: ctx (render přes layout), chyba. Výstup: odeslaná odpověď. Pokud selže i layout, pošle se prostý text.

const { html } = require('../render/html');

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message česká zpráva pro uživatele
   * @param {object} [details] doplňující data (do logu / JSON odpovědi), nikdy PII
   */
  constructor(status, message, details) {
    super(message || STATUS_TEXT[status] || 'Chyba');
    this.name = 'HttpError';
    this.status = Number(status) || 500;
    this.details = details || null;
    this.expose = this.status < 500;
  }
}

const STATUS_TEXT = {
  400: 'Neplatný požadavek',
  403: 'Přístup odepřen',
  404: 'Stránka nenalezena',
  405: 'Metoda není povolena',
  413: 'Příliš velký požadavek',
  415: 'Nepodporovaný formát dat',
  429: 'Příliš mnoho požadavků',
  500: 'Chyba serveru',
};

const DESCRIPTIONS = {
  404: 'Stránka, kterou hledáte, neexistuje nebo byla přesunuta. Zkontrolujte adresu, nebo pokračujte na domovskou stránku.',
  403: 'Požadavek nebylo možné provést.',
  405: 'Tuto akci nelze provést touto metodou.',
  413: 'Odeslaná data jsou příliš velká (limit 256 KB).',
  429: 'Z vaší adresy přišlo příliš mnoho požadavků. Počkejte chvíli a zkuste to znovu.',
  500: 'Omlouváme se, při zpracování požadavku nastala neočekávaná chyba. Zkuste to prosím za chvíli znovu.',
};

/** Tělo chybové stránky (bez layoutu) – komponenty se načítají líně, aby nevznikl cyklus. */
function errorBody({ status, message, requestId }) {
  const { section, button } = require('../render/components');
  const title = STATUS_TEXT[status] || 'Chyba';
  return section({
    title: `${status} · ${title}`,
    lead: message || DESCRIPTIONS[status] || '',
    variant: 'error',
    children: html`
      ${status >= 500 && requestId ? html`<p class="error-page__id">Identifikátor požadavku: <code>${requestId}</code></p>` : ''}
      <p class="error-page__actions">${button({ label: 'Na domovskou stránku', href: '/', variant: 'primary' })} ${button({ label: 'Kontakt', href: '/kontakt', variant: 'ghost' })}</p>
    `,
  });
}

/**
 * Odešle chybovou stránku v layoutu. Pro JSON požadavky (Accept: application/json nebo cesta /api/) pošle JSON.
 * @param {object} ctx
 * @param {number} status
 * @param {{message?: string, requestId?: string}} [opts]
 */
function sendErrorPage(ctx, status, { message, requestId } = {}) {
  const text = message || DESCRIPTIONS[status] || STATUS_TEXT[status] || 'Chyba';
  const wantsJson = ctx.url.pathname.startsWith('/api/') || /\bapplication\/json\b/.test(String(ctx.req.headers.accept || ''));
  if (wantsJson) {
    return ctx.json({ ok: false, error: text, status, requestId: status >= 500 ? requestId : undefined }, status);
  }
  try {
    const { layout } = require('../render/layout');
    const page = layout(ctx, {
      title: `${status} · ${STATUS_TEXT[status] || 'Chyba'}`,
      description: text,
      body: errorBody({ status, message: text, requestId }),
      noindex: true,
    });
    return ctx.html(page, status);
  } catch (e) {
    ctx.log.error('Chybovou stránku nelze vyrenderovat', { error: e.message, requestId });
    ctx.res.statusCode = status;
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end(`${status} ${STATUS_TEXT[status] || 'Chyba'}\n${text}\n`);
    return undefined;
  }
}

function notFound(ctx) {
  return sendErrorPage(ctx, 404);
}

/** Zaloguje chybu (bez PII) a pošle 500 s request id. */
function serverError(ctx, err) {
  ctx.log.error('Neošetřená chyba při zpracování požadavku', { error: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err), path: ctx.url.pathname, method: ctx.req.method });
  return sendErrorPage(ctx, 500, { requestId: ctx.requestId });
}

module.exports = { HttpError, STATUS_TEXT, DESCRIPTIONS, sendErrorPage, notFound, serverError, errorBody };
