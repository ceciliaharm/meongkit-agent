# meongkit-agent — Proof Gatekeeper for zkVerify Agent Games Season 01

Agent **"meongkit"** for the [zkVerify Agent Games](https://agentgames.zkverify.io)
Season 01 (21 Oct – 21 Nov 2026). One track: **Proof Gatekeeper** — the
platform POSTs signed payment-task envelopes to this agent's public HTTPS
endpoint; the agent decides APPROVE/REJECT and proves every decision with a
real Groth16 proof from the platform's official circuit.

> **Status: built and tested locally. NOT deployed, NOT registered.**
> The remaining owner steps are at the bottom of this file.

## Quick start

```
npm install
npm run fetch-circuits   # downloads the official circuit artifacts into circuits/ (not committed: binary files)
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET (see below)
npm start              # listens on http://0.0.0.0:3000
npm test               # full local self-test (boots the real server)
```

## How it works

```
platform POST /agent  (header x-agent-games-signature, HMAC-SHA256 over raw body)
  -> HMAC verified BEFORE parsing (401 otherwise, no decision)
  -> preflight: {"ok": true, "protocolVersion": "v1"}
  -> gatekeeper: decide + prove (Groth16, official circuit)
  -> every response signed the same way (x-agent-games-signature)
```

**Decision rule** (mirrors the circuit): APPROVE only when
`proof_vk == registered_vk` AND `public_balance >= minimum` AND
`current_block < expiry_block` AND `recipient == condition_recipient` AND
`amount <= max_transfer` AND the `proof_tx` has not been seen before.
Otherwise REJECT with the matching reason code: `VK_SUBSTITUTION`,
`THRESHOLD_MISMATCH`, `PROOF_REUSED`, `EXPIRED_CONDITION`,
`RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW` (plus `MISSING_VERIFICATION` when
required fields are absent).

**Proving** (`lib/proof.js`): snarkjs `groth16.fullProve` with the official
`gatekeeper.wasm` / `gatekeeper_final.zkey`, then the proof is verified
locally against `verification_key.json` before it is returned. A proof is
never fabricated: if proving fails, the response is REJECT with
`reason_code: PROOF_FAILED`, `proof: null`, and a `proof_status`
explanation. `PROOF_REUSED` carries no proof by design — the circuit
asserts `decision == all-five-checks`, so a REJECT on an otherwise-valid
condition has no witness. The server enforces a 55 s response budget and
fails closed with 503 on timeout.

**Idempotency** (`lib/store.js`): responses are cached by `task_id` (a
redelivery returns the identical response, not a false reuse), and used
`proof_tx` values are recorded in `data/seen.json` (JSON-file backed).

**Proof submission** (`lib/kurier.js`, optional): when `KURIER_API_KEY` is
set, proofs are submitted to zkVerify via Kurier
(`POST https://api.kurier.xyz/api/v1/submit-proof/${KURIER_API_KEY}`) and
the job is polled (bounded, default 10 s) for the on-chain tx hash, which
is returned as `proof_tx`. Without a key, `proof_tx` stays `null` and the
proof is still returned in the response.

## Endpoints

- `GET /health` → exactly `{ ok: true, protocolVersion: "v1" }`
- `POST /agent` — preflight (`agent-games.preflight.v1` →
  `{ ok: true, protocolVersion: "v1" }`, signed) and gatekeeper tasks
  (`agent-games.proof-gatekeeper.v1`). Register the **full path** `/agent`
  with the platform.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | **yes** | — | 32-byte secret from the dashboard, shown once at registration. Never commit. |
| `AGENT_GAMES_HMAC_SECRET_HEX` | no | `0` | Set `1` if the secret is hex-encoded. |
| `KURIER_API_KEY` | no | — | From zkVerify. Without it, `proof_tx` stays `null`. |
| `KURIER_API_URL` | no | `https://api.kurier.xyz/api/v1` | |
| `KURIER_POLL_BUDGET_MS` | no | `10000` | |
| `PORT` | no | `3000` | |
| `TASK_SOFT_DEADLINE_MS` | no | `55000` | Must stay < 60000 (platform hard deadline). |
| `GATEKEEPER_VK_HASH` | no | `0x6b79…77b0` | Registered gatekeeper vk hash (from `/api/circuit-info`). |
| `CIRCUITS_DIR` | no | `./circuits` | |
| `SEEN_STORE_PATH` | no | `./data/seen.json` | (`/tmp/meongkit-seen.json` on Vercel.) |
| `AGENT_NAME` | no | `meongkit` | |

Secrets come from env / `.env` only. `.env` is gitignored.

## Circuits

The official gatekeeper artifacts live in `circuits/`. The two binary
artifacts are NOT committed in this repo — fetch them with
`npm run fetch-circuits` (downloads + checksum-verifies):

| File | SHA-256 |
| --- | --- |
| `gatekeeper.wasm` (1,755,820 B) | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `gatekeeper_final.zkey` (309,750 B) | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| `verification_key.json` | extracted from the zkey (`groth16/bn128, nPublic=13`) |

To re-download and re-verify from scratch: `npm run fetch-circuits`.

## Tests

```
npm test
```

Boots the real server (child process, test secret, throwaway seen-store)
and replays spec-shaped envelopes: health exact shape, HMAC accept/reject
(missing, wrong secret, tampered body), preflight + valid response
signature, valid task → APPROVE with a locally-verified proof, all six
traps → correct REJECT + reason code with verified proofs, PROOF_REUSED
with `proof: null`, idempotent redelivery, the `current_block ==
expiry_block` boundary, malformed JSON / unknown type → 400.

## Deploy

### Option A — fly.io (recommended: long-lived, seen-store survives rounds)

```
fly launch --no-deploy   # or: fly apps create meongkit-agent
fly secrets set AGENT_GAMES_HMAC_SECRET=<paste the dashboard secret>
# fly secrets set KURIER_API_KEY=<optional>
fly deploy               # note the public https://meongkit-agent.fly.dev URL
curl https://meongkit-agent.fly.dev/health
```

`fly.toml` targets region `sin` (Singapore) with one machine always running
(`auto_stop_machines = "off"`).

### Option B — Vercel (fastest to a public HTTPS URL)

```
vercel login
vercel --prod            # prints https://<project>.vercel.app
vercel env add AGENT_GAMES_HMAC_SECRET production
vercel env add KURIER_POLL_BUDGET_MS production   # 5000 (Hobby 10 s cap)
vercel --prod
curl https://<host>/agent   # expect {"ok":true,"protocolVersion":"v1"}
```

Caveats: serverless functions on Hobby are capped at ~10 s, and the
seen-store file lives in `/tmp` and can reset on cold start — a reset means
a reused `proof_tx` could be approved in a later round. For the 8
Gatekeeper rounds, a long-lived host (Option A) is the safer choice.

## Register (owner steps on the Agent Games dashboard)

1. Create the public repo on your personal GitHub account and push this code.
2. On the Agent Games dashboard, register the agent:
   - **Repository URL:** `https://github.com/<your-account>/meongkit-agent`
   - **Agent Endpoint:** `https://<your-host>/agent` (the full `/agent` path)
   - Agent name `meongkit`, track **Proof Gatekeeper**.
3. The dashboard shows the HMAC secret **once** at registration — copy it
   into `.env` / `fly secrets set` immediately (it is never shown again;
   it can be rotated from agent settings).
4. Get a Kurier API key from zkVerify and set `KURIER_API_KEY` the same way
   (the agent still works without it, but `proof_tx` stays `null`).
5. Pass the signed preflight (automatic once the endpoint is live) and run
   at least one practice task (practice mode: no leaderboard effect).
6. Prize eligibility requires the connected GitHub account + a connected
   wallet address.

## Assumptions (read before registering)

- **Boundary (verified, not assumed):** `current_block == expiry_block`
  counts as EXPIRED. The circuit uses strict `<`: witness generation
  fails for decision=1 at equality (assert at GatekeeperEvaluation line
  102), and the self-test covers this case with a real REJECT proof.
- **taskId encoding:** `SHA-256(task_id) mod p`. The platform cannot
  recompute public signal 0 without the private salt, so any deterministic
  encoding keeps the proof cryptographically valid; only the 12 public
  field inputs are checkable by the platform.
- **Salt:** derived deterministically as
  `HMAC(secret, "gatekeeper-salt:" + task_id) mod p`, so a redelivered
  task reproduces identical proof inputs.
- **Missing `proof_tx`:** treated as "nothing to reuse" (not a failure) —
  the circuit has no `proof_tx` input, so such a task is still provable.
- **Kurier job-status path** (`/api/v1/proof-status`) is the documented
  default; if it is wrong, proofs still return in the response and
  `proof_tx` stays `null` with a `poll_timeout` status — the response
  never fails because of it.

## Repo layout

```
server.js           HTTP server (raw-body HMAC gate, routing, 55 s budget)
lib/
  config.js         env config + tiny .env loader (no secret has a default)
  hmac.js           HMAC-SHA256 verify/sign (x-agent-games-signature)
  decision.js       deterministic decision rule + circuit input mapping
  proof.js          snarkjs Groth16 proving + local verification
  kurier.js         Kurier submission + bounded poll (never throws)
  store.js          seen proof_tx set + response cache (JSON-file backed)
  handler.js        request pipeline shared by server.js and api/agent.js
api/agent.js        Vercel serverless entry
circuits/           official gatekeeper .wasm/.zkey/verification_key.json
scripts/
  fetch-circuits.js re-download + checksum-verify the circuit artifacts
  extract-vkey.js   extract verification_key.json from the zkey
test/selftest.js    local end-to-end suite (npm test)
```

## Never

- Never fake a proof. Never commit secrets (`.env` is gitignored; the
  HMAC secret and Kurier key live only in env / host secrets).
- Never claim this agent is registered or deployed — it is neither, until
  the owner does the steps under "Register".
