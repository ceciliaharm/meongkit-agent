// Proof Gatekeeper agent — zkVerify Agent Games Season 01.
// Plain Node.js HTTP server (no framework): raw-body HMAC gate, POST /agent,
// GET /health. The server refuses to start without a real HMAC secret
// (set AGENT_GAMES_HMAC_SECRET) unless ALLOW_UNSIGNED=1 (local dev only).
const http = require('http');
const { config } = require('./lib/config');
const { createHandler } = require('./lib/handler');

const cfg = config();

if (!cfg.hmacSecret && !cfg.allowUnsigned) {
  console.error(
    'ERROR: AGENT_GAMES_HMAC_SECRET is not set.\n' +
      'Register the agent on the Agent Games dashboard, copy the one-time HMAC\n' +
      'secret, and put it in .env (see .env.example). For local testing only,\n' +
      'you can run with ALLOW_UNSIGNED=1 instead.'
  );
  process.exit(1);
}
if (cfg.allowUnsigned && !cfg.hmacSecret) {
  console.error('WARNING: running with ALLOW_UNSIGNED=1 — requests are NOT verified. Dev only.');
}

const { handle } = createHandler(cfg);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const rawBody = req.method === 'POST' ? await readRawBody(req) : Buffer.alloc(0);
    const result = await handle(req.method, urlPath, rawBody, req.headers);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (e) {
    console.error('[server] error:', e);
    const body = Buffer.from(JSON.stringify({ error: 'internal_error' }), 'utf8');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(body);
  }
});

server.listen(cfg.port, () => {
  console.log(`meongkit-agent listening on :${cfg.port} (agent: ${cfg.agentName})`);
  console.log(`  GET  /health  -> { ok: true, protocolVersion: "v1" }`);
  console.log(`  POST /agent    -> preflight + proof-gatekeeper tasks`);
});
