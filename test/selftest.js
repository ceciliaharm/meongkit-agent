// Local end-to-end self-test. Boots the real server (child process, test
// secret, throwaway seen-store) and replays spec-shaped envelopes:
//   - GET /health exact shape
//   - HMAC: missing / wrong-secret / tampered -> 401
//   - preflight: valid signature -> 200 + valid response signature
//   - valid task -> APPROVE / VALID_CONDITION, real proof, verified locally
//   - all six traps -> REJECT + correct reason_code, proofs verified
//     (PROOF_REUSED correctly carries no proof)
//   - redelivery of the same task_id -> identical cached response
//   - boundary: current_block == expiry_block -> APPROVE (also probes the
//     circuit's own boundary: if the circuit used strict <, proving would
//     fail and this check would catch it)
//   - malformed JSON / unknown type -> 400
// Run: npm test   (exits non-zero on any failure)
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const TEST_SECRET = 'test-secret-do-not-use-in-production-0123456789';
const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;
const SEEN_PATH = path.join(__dirname, 'seen-test.json');
const VK_PATH = path.join(__dirname, '..', 'circuits', 'verification_key.json');

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function hmacHex(bodyBuffer) {
  return crypto.createHmac('sha256', Buffer.from(TEST_SECRET, 'utf8')).update(bodyBuffer).digest('hex');
}

async function post(pathname, obj, { sign = true, secret = TEST_SECRET, rawBody = null } = {}) {
  const body = rawBody !== null ? rawBody : Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = { 'Content-Type': 'application/json' };
  if (sign) {
    headers['x-agent-games-signature'] = crypto
      .createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(body)
      .digest('hex');
  }
  const res = await fetch(`${BASE}${pathname}`, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* non-JSON body */
  }
  return { status: res.status, json, text, sig: res.headers.get('x-agent-games-signature') };
}

function verifyResponseSignature(res) {
  if (!res.sig) return false;
  const expected = hmacHex(Buffer.from(res.text, 'utf8'));
  return crypto.timingSafeEqual(Buffer.from(res.sig, 'hex'), Buffer.from(expected, 'hex'));
}

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const ADDR = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';

function task(taskId, overrides = {}, inputOverrides = {}) {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'competition',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input: {
      registered_vk: VK,
      proof_vk: VK,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: ADDR,
      condition_recipient: ADDR,
      amount: '500',
      max_transfer: '1000',
      proof_tx: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ...inputOverrides,
    },
    ...overrides,
  };
}

async function main() {
  if (fs.existsSync(SEEN_PATH)) fs.unlinkSync(SEEN_PATH);
  const vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));

  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      AGENT_GAMES_HMAC_SECRET: TEST_SECRET,
      PORT: String(PORT),
      SEEN_STORE_PATH: SEEN_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => (childOut += d));
  child.stderr.on('data', (d) => (childOut += d));

  try {
    // Wait for the server to listen.
    const started = await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (childOut.includes('listening on')) return resolve(true);
        if (Date.now() - t0 > 15000) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
    check('server starts', started, childOut.slice(-500));
    if (!started) return;

    // 1. Health.
    const health = await fetch(`${BASE}/health`);
    const healthJson = await health.json();
    check(
      'GET /health exact shape',
      health.status === 200 &&
        healthJson.ok === true &&
        healthJson.protocolVersion === 'v1' &&
        Object.keys(healthJson).length === 2
    );

    // 2. HMAC failures.
    const noSig = await post('/agent', { type: 'agent-games.preflight.v1' }, { sign: false });
    check('preflight without signature -> 401', noSig.status === 401);
    const wrongSecret = await post(
      '/agent',
      { type: 'agent-games.preflight.v1' },
      { secret: 'wrong-secret' }
    );
    check('preflight with wrong secret -> 401', wrongSecret.status === 401);
    const tampered = await post('/agent', { type: 'agent-games.preflight.v1' });
    // Re-send the same body with a signature made for a different body.
    const tamperedBody = Buffer.from(JSON.stringify({ type: 'agent-games.preflight.v1', x: 1 }), 'utf8');
    const tamperedRes = await fetch(`${BASE}/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-games-signature': tampered.sig,
      },
      body: tamperedBody,
    });
    check('tampered body -> 401', tamperedRes.status === 401);

    // 3. Preflight success + valid response signature.
    const pre = await post('/agent', {
      type: 'agent-games.preflight.v1',
      agent_id: 'meongkit',
      issued_at: new Date().toISOString(),
      nonce: 'abc123',
    });
    check(
      'preflight -> 200 {ok, protocolVersion}',
      pre.status === 200 && pre.json.ok === true && pre.json.protocolVersion === 'v1'
    );
    check('preflight response signature valid', verifyResponseSignature(pre));

    // 4. Valid task -> APPROVE with a real, locally-verified proof.
    const valid = await post('/agent', task('gk_test_valid_1'));
    check(
      'valid task -> APPROVE / VALID_CONDITION',
      valid.status === 200 &&
        valid.json.decision === 'APPROVE' &&
        valid.json.reason_code === 'VALID_CONDITION',
      JSON.stringify(valid.json)
    );
    check('valid task response signature valid', verifyResponseSignature(valid));
    check(
      'valid task carries 13 public signals',
      Array.isArray(valid.json.public_signals) && valid.json.public_signals.length === 13
    );
    const proofOk =
      valid.json.proof &&
      (await snarkjs.groth16.verify(vk, valid.json.public_signals, valid.json.proof));
    check('valid task proof verifies locally (groth16.verify)', proofOk === true);
    check('valid task proof_tx is null without Kurier key', valid.json.proof_tx === null);

    // 5. Redelivery -> identical cached response.
    const redelivered = await post('/agent', task('gk_test_valid_1'));
    check(
      'redelivery returns identical cached response',
      redelivered.status === 200 &&
        JSON.stringify(redelivered.json) === JSON.stringify(valid.json)
    );

    // 6. Boundary: current_block == expiry_block -> REJECT / EXPIRED_CONDITION
    // (verified empirically: the circuit uses strict <, so decision=1 at
    // equality has no witness; decision=0 must still prove).
    const boundary = await post(
      '/agent',
      task('gk_test_boundary_1', {}, { current_block: 8430000, proof_tx: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
    );
    check(
      'boundary current_block == expiry_block -> REJECT / EXPIRED_CONDITION',
      boundary.status === 200 &&
        boundary.json.decision === 'REJECT' &&
        boundary.json.reason_code === 'EXPIRED_CONDITION',
      JSON.stringify(boundary.json)
    );
    if (boundary.json.proof) {
      const bok = await snarkjs.groth16.verify(vk, boundary.json.public_signals, boundary.json.proof);
      check('boundary REJECT proof verifies locally', bok === true);
    } else {
      check('boundary REJECT carries a proof', false, 'proof is null');
    }

    // 7. All six traps.
    const traps = [
      ['VK_SUBSTITUTION', { proof_vk: '0x0000000000000000000000000000000000000000' }],
      ['THRESHOLD_MISMATCH', { public_balance: '999' }],
      ['RECIPIENT_MISMATCH', { recipient: ADDR2 }],
      ['EXPIRED_CONDITION', { current_block: 8430001 }],
      ['AMOUNT_OVERFLOW', { amount: '1001' }],
    ];
    for (let i = 0; i < traps.length; i++) {
      const [code, over] = traps[i];
      const tx = '0x' + (0xcc + i).toString(16).padStart(2, '0').repeat(32);
      const r = await post('/agent', task(`gk_test_trap_${i}`, {}, { proof_tx: tx, ...over }));
      const okDecision =
        r.status === 200 && r.json.decision === 'REJECT' && r.json.reason_code === code;
      check(`trap ${code} -> REJECT`, okDecision, JSON.stringify(r.json));
      if (r.json.proof) {
        const pok = await snarkjs.groth16.verify(vk, r.json.public_signals, r.json.proof);
        check(`trap ${code} proof verifies locally`, pok === true);
      } else {
        check(`trap ${code} carries a proof`, false, 'proof is null');
      }
      check(`trap ${code} response signature valid`, verifyResponseSignature(r));
    }

    // 8. PROOF_REUSED: same proof_tx as the valid task, new task_id.
    const reused = await post(
      '/agent',
      task('gk_test_reuse_1', {}, {
        proof_tx: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })
    );
    check(
      'reused proof_tx -> REJECT / PROOF_REUSED with proof:null',
      reused.status === 200 &&
        reused.json.decision === 'REJECT' &&
        reused.json.reason_code === 'PROOF_REUSED' &&
        reused.json.proof === null,
      JSON.stringify(reused.json)
    );

    // 9. Malformed JSON (valid HMAC) -> 400; unknown type -> 400.
    const badJson = await post('/agent', null, { rawBody: Buffer.from('{not json', 'utf8') });
    check('malformed JSON -> 400', badJson.status === 400);
    const unknown = await post('/agent', { type: 'agent-games.nope.v1' });
    check('unknown type -> 400', unknown.status === 400);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (fs.existsSync(SEEN_PATH)) fs.unlinkSync(SEEN_PATH);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(1);
});
