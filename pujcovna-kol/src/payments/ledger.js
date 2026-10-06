'use strict';
// Ledger – evidence pohybů peněz k rezervaci (SPEC kap. 10): každý pohyb = řádek v ledger_entries.
//   add(db, { reservationId, type, amountMinor, paymentId, note, now })   → id řádku
//       type ∈ fee_paid | balance_paid | deposit_held | deposit_captured | deposit_released | refund | fee_forfeited | damage
//   list(db, reservationId)                                               → řádky ledger_entries (chronologicky)
//   balance(db, reservationId) → { totalMinor, paidMinor, feePaidMinor, balancePaidMinor, depositHeldMinor,
//       depositCapturedMinor, depositReleasedMinor, refundedMinor, forfeitedMinor, damageMinor, dueMinor }
//       paidMinor = fee_paid + balance_paid − refund (skutečně přijaté a nevrácené peníze za pronájem)
//       dueMinor  = max(0, total + damage − paid − deposit_captured); u zrušených / propadlých rezervací 0
//   TYPES, LABELS (české popisky pro UI)
// Pozn.: přechody rezervace (domain/reservations.transition) zapisují ledger samy (fee_paid, deposit_*, refund,
// fee_forfeited, damage); tento modul používají platby pro doplatky mimo přechod a admin pro přehledy.
// Vstup: db tenanta, peníze v haléřích (INTEGER), časy ISO UTC.

const { nowIso } = require('../db');

const TYPES = Object.freeze(['fee_paid', 'balance_paid', 'deposit_held', 'deposit_captured', 'deposit_released', 'refund', 'fee_forfeited', 'damage']);

const LABELS = Object.freeze({
  fee_paid: 'Poplatek zaplacen',
  balance_paid: 'Doplatek zaplacen',
  deposit_held: 'Kauce složena',
  deposit_captured: 'Stržení z kauce',
  deposit_released: 'Kauce uvolněna',
  refund: 'Vratka',
  fee_forfeited: 'Poplatek propadl',
  damage: 'Poškození',
});

const CLOSED_STATES = new Set(['expired', 'cancelled_by_customer', 'cancelled_by_operator', 'no_show']);

/** Zapíše pohyb. amountMinor musí být kladné celé číslo (směr určuje type). */
function add(db, { reservationId, type, amountMinor, paymentId = null, note = null, now = nowIso() }) {
  if (!TYPES.includes(type)) throw new Error(`Ledger: neznámý typ pohybu „${type}“.`);
  const amount = Math.round(Number(amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Ledger: částka musí být kladné číslo v haléřích.');
  const id = Number(reservationId);
  if (!Number.isInteger(id)) throw new Error('Ledger: chybí id rezervace.');
  const r = db
    .prepare('INSERT INTO ledger_entries(reservation_id, type, amount_minor, payment_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, type, amount, paymentId === undefined ? null : paymentId, note === undefined ? null : note, now);
  return Number(r.lastInsertRowid);
}

function list(db, reservationId) {
  return db.prepare('SELECT * FROM ledger_entries WHERE reservation_id = ? ORDER BY id').all(Number(reservationId));
}

/** Součty podle typu + saldo rezervace. */
function balance(db, reservationId) {
  const id = Number(reservationId);
  const r = db.prepare('SELECT status, total_minor FROM reservations WHERE id = ?').get(id);
  const sums = {};
  for (const t of TYPES) sums[t] = 0;
  for (const row of db.prepare('SELECT type, SUM(amount_minor) AS s FROM ledger_entries WHERE reservation_id = ? GROUP BY type').all(id)) sums[row.type] = Number(row.s) || 0;
  const totalMinor = r ? Number(r.total_minor) || 0 : 0;
  const paidMinor = sums.fee_paid + sums.balance_paid - sums.refund;
  const closed = r ? CLOSED_STATES.has(r.status) : false;
  const dueMinor = closed ? 0 : Math.max(0, totalMinor + sums.damage - paidMinor - sums.deposit_captured);
  return {
    totalMinor,
    paidMinor,
    feePaidMinor: sums.fee_paid,
    balancePaidMinor: sums.balance_paid,
    depositHeldMinor: sums.deposit_held,
    depositCapturedMinor: sums.deposit_captured,
    depositReleasedMinor: sums.deposit_released,
    refundedMinor: sums.refund,
    forfeitedMinor: sums.fee_forfeited,
    damageMinor: sums.damage,
    dueMinor,
  };
}

module.exports = { TYPES, LABELS, add, list, balance };
