// Seen proof_tx set + idempotent response cache, JSON-file backed.
// The seen set is what catches the PROOF_REUSED trap: a proof_tx that was
// already used in an earlier task must be rejected. The cache makes a
// redelivered task_id return the identical response instead of being
// misread as a reuse. Persistence is best-effort: if the file cannot be
// written (e.g. read-only serverless disk), the in-memory state still works
// for the life of the process.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.seen = new Set();
    this.cache = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data.seen)) data.seen.forEach((t) => this.seen.add(t));
      if (data.cache && typeof data.cache === 'object') {
        for (const [k, v] of Object.entries(data.cache)) this.cache.set(k, v);
      }
    } catch (e) {
      console.error(`[store] could not load ${this.filePath}: ${e.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          { seen: [...this.seen], cache: Object.fromEntries(this.cache) },
          null,
          2
        )
      );
    } catch (e) {
      console.error(`[store] could not save ${this.filePath}: ${e.message}`);
    }
  }

  hasSeen(tx) {
    return this.seen.has(String(tx).toLowerCase());
  }

  markSeen(tx) {
    if (!tx) return;
    this.seen.add(String(tx).toLowerCase());
    this.save();
  }

  getCached(taskId) {
    return this.cache.get(String(taskId));
  }

  setCached(taskId, responseBody) {
    this.cache.set(String(taskId), responseBody);
    this.save();
  }
}

module.exports = { Store };
