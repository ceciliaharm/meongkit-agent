// Vercel serverless entry. Reuses the same request pipeline as server.js.
// Deploy notes (see README): circuits are committed in this repo, so no
// build-time download is needed. Caveats on Vercel Hobby: functions are
// capped at ~10 s, and the seen-store file lives in /tmp and can reset on
// cold start — for the 8 Gatekeeper rounds, a long-lived host (fly.io) is
// the safer choice.
const { config } = require('../lib/config');
const { createHandler } = require('../lib/handler');

const cfg = config();
const { handle } = createHandler(cfg);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  try {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const rawBody = req.method === 'POST' ? await readRawBody(req) : Buffer.alloc(0);
    const result = await handle(req.method, urlPath, rawBody, req.headers);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (e) {
    console.error('[api/agent] error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
};
