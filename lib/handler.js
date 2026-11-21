// Framework-agnostic request pipeline shared by the plain-Node server
// (server.js) and the Vercel serverless entry (api/agent.js).
//
// Flow for POST /agent:
//   1. Verify HMAC-SHA256 over the RAW body (before JSON parsing).
//      Mismatch -> 401, no decision.
//   2. Parse JSON. Malformed -> 400.
//   3. type = agent-games.preflight.v1 -> { ok: true, protocolVersion: "v1" }.
//   4. type = agent-games.proof-gatekeeper.v1 -> decide, prove, submit, respond.
//   5. Anything else -> 400.
// Every response is signed with x-agent-games-signature (HMAC over the raw
// response body). Fail closed throughout: errors resolve to REJECT, never to
// an unproven APPROVE. Whole task handling is bounded by TASK_SOFT_DEADLINE_MS
// (default 55 s); on timeout the client gets 503.
const { verifyHmac, signHex } = require('./hmac');
const { decide, toCircuitInput } = require('./decision');
const { prove } = require('./proof');
const { submitProof } = require('./kurier');
const { Store } = require('./store');

const HEALTH_BODY = { ok: true, protocolVersion: 'v1' };

function createHandler(cfg) {
  const store = new Store(cfg.seenStorePath);

  function signedResponse(status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const headers = { 'Content-Type': 'application/json' };
    const sig = signHex(cfg, body);
    if (sig) headers['x-agent-games-signature'] = sig;
    return { status, headers, body };
  }

  async function handleGatekeeper(envelope) {
    const taskId = envelope.task_id;
    const input = envelope.input;
    if (!taskId || typeof taskId !== 'string' || !input || typeof input !== 'object') {
      return signedResponse(400, { error: 'invalid_envelope' });
    }

    // Idempotent redelivery: same task_id returns the cached response.
    const cached = store.getCached(taskId);
    if (cached) return signedResponse(200, cached);

    const outcome = decide(input, (tx) => store.hasSeen(tx));

    let proof = null;
    let publicSignals = null;
    let proofStatus = null;

    if (outcome.provable) {
      try {
        const circuitInput = toCircuitInput(
          taskId,
          input,
          outcome.decision,
          cfg.hmacSecret
        );
        const made = await prove(cfg.circuitsDir, circuitInput);
        proof = made.proof;
        publicSignals = made.publicSignals;
      } catch (e) {
        // Never return an unproven APPROVE. Fail closed to REJECT.
        // Do NOT cache this outcome: a transient proving failure must not
        // poison a later redelivery of the same task.
        console.error(`[gatekeeper] proving failed for ${taskId}: ${e.message}`);
        return signedResponse(200, {
          decision: 'REJECT',
          reason_code: 'PROOF_FAILED',
          proof: null,
          public_signals: null,
          proof_tx: null,
          proof_status: `proving failed: ${e.message}`,
        });
      }
    } else {
      proofStatus =
        outcome.reason_code === 'PROOF_REUSED'
          ? 'no proof: proof_tx already seen (replay tasks are excluded from proof scoring)'
          : `no proof: ${outcome.detail || outcome.reason_code}`;
    }

    // Kurier submission is optional and best-effort.
    let proofTx = null;
    let submissionStatus = 'skipped_no_key';
    if (proof) {
      const sub = await submitProof(cfg, proof, publicSignals);
      submissionStatus = sub.status;
      proofTx = sub.txHash || input.proof_tx || null;
      if (!cfg.kurierApiKey) proofTx = null;
    }

    const response = {
      decision: outcome.decision,
      reason_code: outcome.reason_code,
      proof,
      public_signals: publicSignals,
      proof_tx: proofTx,
    };
    if (proofStatus) response.proof_status = proofStatus;
    return finish(response);

    function finish(response) {
      store.setCached(taskId, response);
      if (input.proof_tx) store.markSeen(input.proof_tx);
      return signedResponse(200, response);
    }
  }

  // Main entry: method + path + raw body buffer + headers object.
  // Returns { status, headers, body: Buffer }.
  async function handle(method, urlPath, rawBody, headers) {
    if (method === 'GET' && (urlPath === '/health' || urlPath === '/agent' || urlPath === '/')) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(HEALTH_BODY), 'utf8'),
      };
    }
    if (method !== 'POST' || urlPath !== '/agent') {
      return signedResponse(404, { error: 'not_found' });
    }

    if (!verifyHmac(cfg, rawBody, headers['x-agent-games-signature'])) {
      return signedResponse(401, { error: 'unauthorized' });
    }

    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
      return signedResponse(400, { error: 'invalid_json' });
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      return signedResponse(400, { error: 'invalid_envelope' });
    }

    if (envelope.type === 'agent-games.preflight.v1') {
      return signedResponse(200, HEALTH_BODY);
    }

    if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
      const timeout = new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              signedResponse(503, {
                error: 'timeout',
                proof: null,
                proof_status: 'task handling exceeded the response budget',
              })
            ),
          cfg.taskBudgetMs
        )
      );
      return Promise.race([handleGatekeeper(envelope), timeout]);
    }

    return signedResponse(400, { error: 'unknown_type' });
  }

  return { handle, store };
}

module.exports = { createHandler, HEALTH_BODY };
