// Download the official gatekeeper circuit artifacts from
// agentgames.zkverify.io/circuits/ and verify their SHA-256 checksums.
// Also (re)extracts circuits/verification_key.json from the zkey.
// Run: npm run fetch-circuits
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const BASE = 'https://agentgames.zkverify.io/circuits';
const FILES = [
  {
    name: 'gatekeeper.wasm',
    sha256: 'be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f',
  },
  {
    name: 'gatekeeper_final.zkey',
    sha256: 'adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d',
  },
];

function download(url, dest) {
  // Download to a temp file first and only replace the destination on
  // success, so a failed download never deletes a good artifact.
  const tmp = `${dest}.tmp`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          try {
            fs.unlinkSync(tmp);
          } catch (_) {}
          return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve();
          });
        });
      })
      .on('error', (e) => {
        file.close();
        try {
          fs.unlinkSync(tmp);
        } catch (_) {}
        reject(e);
      });
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

(async () => {
  const dir = path.join(__dirname, '..', 'circuits');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(dir, f.name);
    console.log(`downloading ${BASE}/${f.name} ...`);
    await download(`${BASE}/${f.name}`, dest);
    const sum = sha256(dest);
    if (sum !== f.sha256) {
      throw new Error(`checksum mismatch for ${f.name}: got ${sum}, want ${f.sha256}`);
    }
    console.log(`  OK ${f.name} (${fs.statSync(dest).size} bytes, sha256 verified)`);
  }
  console.log('extracting verification key ...');
  const { execFileSync } = require('child_process');
  execFileSync('node', [path.join(__dirname, 'extract-vkey.js')], { stdio: 'inherit' });
  // Verify the extracted key semantically (byte checksums vary with JSON
  // formatting across snarkjs versions): it must be a groth16/bn128 key
  // with 13 public inputs (IC length 14).
  const vk = JSON.parse(fs.readFileSync(path.join(dir, 'verification_key.json'), 'utf8'));
  if (vk.protocol !== 'groth16' || vk.curve !== 'bn128' || vk.nPublic !== 13 || vk.IC.length !== 14) {
    throw new Error(`verification_key.json failed semantic check: ${JSON.stringify({ protocol: vk.protocol, curve: vk.curve, nPublic: vk.nPublic, ic: vk.IC && vk.IC.length })}`);
  }
  console.log('  OK verification_key.json (groth16/bn128, nPublic=13)');
  console.log('all circuit artifacts ready.');
})().catch((e) => {
  console.error('fetch-circuits failed:', e.message);
  process.exit(1);
});
