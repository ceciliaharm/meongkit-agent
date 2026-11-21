// Deterministic Gatekeeper decision logic + conversion of a task envelope
// into the official gatekeeper circuit inputs.
//
// Decision rule (mirrors the circuit exactly — the expiry boundary was
// verified empirically: the circuit asserts decision == all-five-checks and
// witness generation FAILS for decision=1 when current_block ==
// expiry_block, so the circuit uses strict <):
//   APPROVE only when proof_vk == registered_vk
//     AND public_balance >= minimum
//     AND current_block < expiry_block
//     AND recipient == condition_recipient
//     AND amount <= max_transfer
//     AND proof_tx has not been seen before.
//   Otherwise REJECT with the matching reason code.
//
// Circuit inputs (GatekeeperEvaluation, 13 inputs):
//   taskId, registeredVkHash, proofVkHash, minimum, publicBalance,
//   expiryBlock, currentBlock, recipient, conditionRecipient, amount,
//   maxTransfer, decision, salt (private).
// Field elements are the envelope values reduced mod the BN128 prime.
// taskId is SHA-256(task_id) mod p (free-form ids are not field elements).
// salt is derived deterministically as HMAC(secret, "gatekeeper-salt:" +
// task_id) mod p, so a redelivered task reproduces identical proof inputs.
//
// ASSUMPTIONS (documented, not verified against the platform):
// - Boundary: current_block == expiry_block counts as valid (<=).
// - taskId encoding: SHA-256 mod p. The platform cannot recompute public
//   signal 0 without the private salt, so any deterministic encoding keeps
//   the proof cryptographically valid; only the 12 public field inputs are
//   checkable by the platform.
const crypto = require('crypto');

const BN128_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const REQUIRED_FIELDS = [
  'registered_vk',
  'proof_vk',
  'minimum',
  'public_balance',
  'expiry_block',
  'current_block',
  'recipient',
  'condition_recipient',
  'amount',
  'max_transfer',
];

function modP(n) {
  const v = BigInt(n) % BN128_PRIME;
  return v < 0n ? v + BN128_PRIME : v;
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    const v = value.trim();
    if (v.startsWith('0x') || v.startsWith('0X')) return BigInt(v);
    if (/^-?\d+$/.test(v)) return BigInt(v);
  }
  throw new Error(`not a field value: ${JSON.stringify(value)}`);
}

function normHex(value) {
  return String(value).trim().toLowerCase();
}

// Decide a gatekeeper task. `seenProofTx` is a function (tx) => boolean.
// Returns { decision: 'APPROVE'|'REJECT', reason_code, provable }.
// provable=false means no circuit proof exists for this outcome
// (PROOF_REUSED: the circuit asserts decision == all-five-checks, so a
// REJECT on an otherwise-valid condition has no witness; MISSING_VERIFICATION:
// the witness cannot even be formed).
function decide(input, seenProofTx) {
  const missing = REQUIRED_FIELDS.filter(
    (f) => input[f] === undefined || input[f] === null || input[f] === ''
  );
  if (missing.length > 0) {
    return {
      decision: 'REJECT',
      reason_code: 'MISSING_VERIFICATION',
      provable: false,
      detail: `missing fields: ${missing.join(', ')}`,
    };
  }

  if (normHex(input.proof_vk) !== normHex(input.registered_vk)) {
    return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION', provable: true };
  }
  if (toBigInt(input.public_balance) < toBigInt(input.minimum)) {
    return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH', provable: true };
  }
  if (normHex(input.recipient) !== normHex(input.condition_recipient)) {
    return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH', provable: true };
  }
  const proofTx = input.proof_tx ? normHex(input.proof_tx) : null;
  if (proofTx && seenProofTx(proofTx)) {
    return {
      decision: 'REJECT',
      reason_code: 'PROOF_REUSED',
      provable: false,
      detail: 'proof_tx already seen',
    };
  }
  if (toBigInt(input.current_block) >= toBigInt(input.expiry_block)) {
    return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION', provable: true };
  }
  if (toBigInt(input.amount) > toBigInt(input.max_transfer)) {
    return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW', provable: true };
  }
  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION', provable: true };
}

// Build the 13 circuit inputs for a decision. `secret` is the HMAC secret
// (used only to derive the deterministic private salt).
function toCircuitInput(taskId, input, decision, secret) {
  const taskIdHash = crypto.createHash('sha256').update(String(taskId), 'utf8').digest();
  const saltHmac = crypto
    .createHmac('sha256', Buffer.from(String(secret || ''), 'utf8'))
    .update(`gatekeeper-salt:${taskId}`)
    .digest();
  const f = (v) => modP(toBigInt(v)).toString();
  return {
    taskId: modP(BigInt('0x' + taskIdHash.toString('hex'))).toString(),
    registeredVkHash: f(input.registered_vk),
    proofVkHash: f(input.proof_vk),
    minimum: f(input.minimum),
    publicBalance: f(input.public_balance),
    expiryBlock: f(input.expiry_block),
    currentBlock: f(input.current_block),
    recipient: f(input.recipient),
    conditionRecipient: f(input.condition_recipient),
    amount: f(input.amount),
    maxTransfer: f(input.max_transfer),
    decision: decision === 'APPROVE' ? '1' : '0',
    salt: modP(BigInt('0x' + saltHmac.toString('hex'))).toString(),
  };
}

module.exports = { decide, toCircuitInput, BN128_PRIME, REQUIRED_FIELDS };
