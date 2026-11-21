// Extract the Groth16 verification key from the official gatekeeper zkey
// and save it as circuits/verification_key.json (used for local proof checks).
// Run: node scripts/extract-vkey.js
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const CIRCUITS_DIR = process.env.CIRCUITS_DIR || path.join(__dirname, '..', 'circuits');

(async () => {
  const zkeyPath = path.join(CIRCUITS_DIR, 'gatekeeper_final.zkey');
  const outPath = path.join(CIRCUITS_DIR, 'verification_key.json');
  const vk = await snarkjs.zKey.exportVerificationKey(zkeyPath);
  fs.writeFileSync(outPath, JSON.stringify(vk, null, 2));
  console.log(`wrote ${outPath} (protocol=${vk.protocol}, curve=${vk.curve}, nPublic=${vk.nPublic})`);
  process.exit(0); // snarkjs leaves handles open; exit explicitly
})().catch((e) => {
  console.error('extract-vkey failed:', e);
  process.exit(1);
});
