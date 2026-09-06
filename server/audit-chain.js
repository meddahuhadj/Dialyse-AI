'use strict';

// Phase 4 — tamper-evident audit trail. Each row carries hash =
// SHA-256(prev_hash | canonical(row)). Any edit/delete/reorder of a past row
// breaks the chain from that point on; GET /api/audit/verify walks it.

const crypto = require('node:crypto');
const { db } = require('./db');

const GENESIS = '0'.repeat(64);

function canonical(row) {
  return [row.time, row.user, row.machine, row.action, row.data ?? '', row.ai ?? '', row.network ?? '', row.created_at].join('');
}

function hashRow(prevHash, row) {
  return crypto.createHash('sha256').update(`${prevHash}${canonical(row)}`).digest('hex');
}

/** Latest hash in the chain (or GENESIS when the table is empty). */
function tipHash() {
  const r = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
  return (r && r.hash) || GENESIS;
}

/** Recompute the whole chain; returns { ok, count, brokenAt? }. */
function verifyChain() {
  const rows = db.prepare('SELECT * FROM audit ORDER BY id ASC').all();
  let prev = GENESIS;
  for (const row of rows) {
    const expected = hashRow(prev, row);
    if (row.prev_hash !== prev || row.hash !== expected) {
      return { ok: false, count: rows.length, brokenAt: row.id };
    }
    prev = row.hash;
  }
  return { ok: true, count: rows.length };
}

module.exports = { GENESIS, canonical, hashRow, tipHash, verifyChain };
