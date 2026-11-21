// Kurier submission (optional). Proofs are submitted to zkVerify via the
// official Kurier flow only. Without a KURIER_API_KEY this module is a
// no-op and the response carries proof_tx: null. It never throws — any
// failure just means proof_tx stays empty and the decision still goes out
// with its proof attached.
const https = require('https');

function postJson(urlString, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text || '{}') });
          } catch (_) {
            resolve({ status: res.statusCode, json: {}, raw: text });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
          } catch (_) {
            resolve({});
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function pickTxHash(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    obj.txHash || obj.tx_hash || obj.transactionHash || obj.txhash || null
  );
}

function pickJobId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.jobId || obj.job_id || obj.id || null;
}

// Submit a proof and poll for the on-chain tx hash, bounded by budgetMs.
// Returns { txHash: string|null, status: string }.
async function submitProof(cfg, proof, publicSignals) {
  const result = { txHash: null, status: 'skipped_no_key' };
  if (!cfg.kurierApiKey) return result;
  const base = cfg.kurierApiUrl.replace(/\/$/, '');
  try {
    const submit = await postJson(
      `${base}/submit-proof/${cfg.kurierApiKey}`,
      {
        proofType: 'groth16',
        vkRegistered: true,
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        proofData: { proof, publicSignals, vk: cfg.gatekeeperVkHash },
      },
      10000
    );
    const jobId = pickJobId(submit.json);
    let tx = pickTxHash(submit.json) || pickTxHash(submit.json && submit.json.data);
    if (tx) return { txHash: tx, status: 'submitted' };
    if (!jobId) return { txHash: null, status: 'submitted_no_job' };
    // Poll job status until a tx hash appears or the budget runs out.
    // IncludedInBlock already carries the final-shaped hash; Finalized
    // (~25 s) follows with the same hash, so it is never awaited in-request.
    const deadline = Date.now() + cfg.kurierPollBudgetMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const st = await getJson(`${base}/proof-status/${jobId}`, 5000);
        tx = pickTxHash(st) || pickTxHash(st && st.data);
        const s = st.status || (st.data && st.data.status) || '';
        if (tx) return { txHash: tx, status: String(s || 'included') };
        if (/final/i.test(String(s))) break;
      } catch (_) {
        /* transient poll error: keep polling until the budget ends */
      }
    }
    return { txHash: null, status: 'poll_timeout' };
  } catch (e) {
    return { txHash: null, status: `error:${e.message}` };
  }
}

module.exports = { submitProof };
