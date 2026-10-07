'use strict';
// Pomůcky pro testy Cloudflare Access: vlastní „tým“ s klíčem RSA, JWKS a podepsané tokeny (bez sítě).
const crypto = require('node:crypto');

function makeTeam({ team = 'bold-dust-a2b5', aud = 'a'.repeat(64), kid = 'klic-1' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const issuer = `https://${team}.cloudflareaccess.com`;
  const state = { keys: [jwk], calls: 0, fail: false };
  const fetchImpl = async (url) => {
    state.calls++;
    if (state.fail) throw new Error('síť nedostupná');
    if (url !== `${issuer}/cdn-cgi/access/certs`) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ keys: state.keys }) };
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims = {}, { key = privateKey, keyId = kid, alg = 'RS256' } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg, kid: keyId, typ: 'JWT' });
    const body = b64({ aud: [aud], email: 'lada@koloshop.cz', exp: now + 3600, iat: now, nbf: now, iss: issuer, type: 'app', sub: 'u-1', ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  return { team, aud, kid, issuer, jwk, privateKey, state, fetchImpl, sign };
}

module.exports = { makeTeam };
