// HMAC-SHA256 signing / verification for the Agent Games protocol.
// The platform signs every request with the agent's secret and expects every
// response signed the same way, in the `x-agent-games-signature` header.
// Signature format: plain hex HMAC over the raw body (base64 also accepted
// on verify). The secret is used as raw UTF-8 bytes by default; set
// AGENT_GAMES_HMAC_SECRET_HEX=1 if the dashboard gave you a hex secret.
const crypto = require('crypto');

function secretBytes(cfg) {
  if (!cfg.hmacSecret) return null;
  if (cfg.hmacSecretHex) return Buffer.from(cfg.hmacSecret, 'hex');
  return Buffer.from(cfg.hmacSecret, 'utf8');
}

function signHex(cfg, bodyBuffer) {
  const key = secretBytes(cfg);
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(bodyBuffer).digest('hex');
}

function decodeSignature(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  let v = headerValue.trim();
  if (v.toLowerCase().startsWith('sha256=')) v = v.slice(7);
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch (_) {
    /* fall through */
  }
  return null;
}

function verifyHmac(cfg, bodyBuffer, headerValue) {
  if (cfg.allowUnsigned) return true;
  const key = secretBytes(cfg);
  if (!key) return false;
  const given = decodeSignature(headerValue);
  if (!given) return false;
  const expected = crypto.createHmac('sha256', key).update(bodyBuffer).digest();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

module.exports = { signHex, verifyHmac, secretBytes };
