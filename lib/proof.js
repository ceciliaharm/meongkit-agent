// Groth16 proving with snarkjs + the official gatekeeper circuit.
// A proof is never fabricated: if proving or local verification fails, the
// caller must fail closed (REJECT, proof: null).
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

let cachedVk = null;

function circuitPaths(circuitsDir) {
  return {
    wasm: path.join(circuitsDir, 'gatekeeper.wasm'),
    zkey: path.join(circuitsDir, 'gatekeeper_final.zkey'),
    vk: path.join(circuitsDir, 'verification_key.json'),
  };
}

function loadVerificationKey(circuitsDir) {
  if (cachedVk) return cachedVk;
  const { vk } = circuitPaths(circuitsDir);
  cachedVk = JSON.parse(fs.readFileSync(vk, 'utf8'));
  return cachedVk;
}

function checkCircuitsPresent(circuitsDir) {
  const p = circuitPaths(circuitsDir);
  const missing = [p.wasm, p.zkey, p.vk].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(`missing circuit files: ${missing.join(', ')} (run: npm run fetch-circuits)`);
  }
}

// Generate a real Groth16 proof for the given circuit inputs and verify it
// locally against the verification key before returning it.
// Returns { proof, publicSignals } — proof is the snarkjs object
// { pi_a, pi_b, pi_c, protocol: 'groth16', curve: 'bn128' }.
async function prove(circuitsDir, circuitInput) {
  checkCircuitsPresent(circuitsDir);
  const { wasm, zkey } = circuitPaths(circuitsDir);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasm,
    zkey
  );
  const vk = loadVerificationKey(circuitsDir);
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error('local proof verification failed');
  return { proof, publicSignals: publicSignals.map(String) };
}

module.exports = { prove, loadVerificationKey, circuitPaths, checkCircuitsPresent };
