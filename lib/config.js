// Environment configuration. No secret has a default value.
// A minimal .env file loader is included so `npm start` works after
// `cp .env.example .env` without any extra dependency.
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const GATEKEEPER_VK_HASH =
  '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

function config() {
  const allowUnsigned = process.env.ALLOW_UNSIGNED === '1';
  const secret = process.env.AGENT_GAMES_HMAC_SECRET || '';
  return {
    agentName: process.env.AGENT_NAME || 'meongkit',
    hmacSecret: secret,
    hmacSecretHex: process.env.AGENT_GAMES_HMAC_SECRET_HEX === '1',
    allowUnsigned,
    kurierApiKey: process.env.KURIER_API_KEY || '',
    kurierApiUrl: process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1',
    kurierPollBudgetMs: Number(process.env.KURIER_POLL_BUDGET_MS || 10000),
    gatekeeperVkHash: process.env.GATEKEEPER_VK_HASH || GATEKEEPER_VK_HASH,
    circuitsDir: process.env.CIRCUITS_DIR || path.join(__dirname, '..', 'circuits'),
    taskBudgetMs: Number(process.env.TASK_SOFT_DEADLINE_MS || 55000),
    port: Number(process.env.PORT || 3000),
    seenStorePath:
      process.env.SEEN_STORE_PATH ||
      (process.env.VERCEL
        ? '/tmp/meongkit-seen.json'
        : path.join(__dirname, '..', 'data', 'seen.json')),
  };
}

module.exports = { config, GATEKEEPER_VK_HASH };
