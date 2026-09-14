/**
 * Internal-transfer and investment pairing. See AGENTS.md §6.
 *
 * Money moving between the user's own accounts is not income and not spending.
 * A bank row saying "转出到支付宝" and the matching Alipay row saying "转入"
 * would otherwise appear as one expense and one income, inflating both.
 */
import type { Transaction } from './types';
import { epochSeconds } from './dates';

export interface TransferPair {
  outIds: string[];
  inIds: string[];
  amountMinor: number;
  /** `exact` = one-to-one equal amount; `grouped` = one-to-many subset sum. */
  mode: 'exact' | 'grouped';
}

export interface PairingOptions {
  /** How far apart the two legs may be. AGENTS.md §6 defaults to ±3 days. */
  windowDays: number;
  /** Largest subset size considered for one-to-many matches. */
  maxGroupSize: number;
}

export const DEFAULT_PAIRING_OPTIONS: PairingOptions = {
  windowDays: 3,
  maxGroupSize: 3,
};

const TRANSFER_HINT_RE = /(转账|转出|转入|充值|提现|代付|划转|汇款|转至|内部|归集)/;

function textOf(tx: Transaction): string {
  return [tx.counterparty ?? '', tx.rawDescription, tx.meta?.['txType'] ?? '', tx.meta?.['method'] ?? '']
    .join(' ')
    .toLowerCase();
}

/** A row is worth matching if it is already flagged, or if its text hints at a transfer. */
export function isPairingCandidate(tx: Transaction): boolean {
  if (tx.kind === 'transfer-investment' || tx.kind === 'transfer-repayment') return false;
  if (tx.kind === 'refund') return false;
  if (tx.kind === 'transfer-internal') return true;
  return TRANSFER_HINT_RE.test(textOf(tx));
}

/**
 * Deliberately NOT requiring the two legs to belong to different accounts.
 *
 * Both legs of a real internal transfer frequently appear in a single export —
 * moving money between 余额 and 余额宝 produces two Alipay rows in the same
 * account. Requiring different accounts would silently skip exactly the case the
 * feature exists for.
 *
 * The conjunction that keeps false positives out is elsewhere: opposite
 * directions, exactly equal amounts, within ±3 days, at least one leg carrying
 * an explicit transfer hint, and neither leg already classified as an
 * investment or repayment.
 */

export function pairInternalTransfers(
  transactions: readonly Transaction[],
  options: Partial<PairingOptions> = {},
): { transactions: Transaction[]; pairs: TransferPair[] } {
  const opts = { ...DEFAULT_PAIRING_OPTIONS, ...options };
  const windowSeconds = opts.windowDays * 86_400;

  const candidates = transactions.filter(isPairingCandidate);
  const candidateIds = new Set(candidates.map((t) => t.id));

  const outs = candidates
    .filter((t) => t.direction === 'out')
    .sort((a, b) => epochSeconds(a.occurredAt) - epochSeconds(b.occurredAt));
  const ins = candidates
    .filter((t) => t.direction === 'in')
    .sort((a, b) => epochSeconds(a.occurredAt) - epochSeconds(b.occurredAt));

  const paired = new Set<string>();
  const pairs: TransferPair[] = [];

  const withinWindow = (a: Transaction, b: Transaction): boolean =>
    Math.abs(epochSeconds(a.occurredAt) - epochSeconds(b.occurredAt)) <= windowSeconds;

  // ---- Pass 1: one-to-one, exact amount, nearest in time wins -------------
  for (const out of outs) {
    if (paired.has(out.id)) continue;

    let best: Transaction | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const inc of ins) {
      if (paired.has(inc.id)) continue;
      if (inc.amountMinor !== out.amountMinor) continue;
      if (!withinWindow(out, inc)) continue;

      const distance = Math.abs(epochSeconds(out.occurredAt) - epochSeconds(inc.occurredAt));
      if (distance < bestDistance) {
        best = inc;
        bestDistance = distance;
      }
    }

    if (best) {
      paired.add(out.id);
      paired.add(best.id);
      pairs.push({ outIds: [out.id], inIds: [best.id], amountMinor: out.amountMinor, mode: 'exact' });
    }
  }

  // ---- Pass 2: one-to-many, subset sum -----------------------------------
  // A single "转出 3000" is often settled as several smaller "转入" legs.
  // Bounded to `maxGroupSize` and a small pool so worst-case cost stays sane.
  const tryGrouped = (single: Transaction, pool: readonly Transaction[], singleIsOut: boolean): void => {
    if (paired.has(single.id)) return;

    const usable = pool
      .filter((t) => !paired.has(t.id) && withinWindow(single, t))
      .slice(0, 24);
    if (usable.length < 2) return;

    const search = (start: number, remaining: number, chosen: Transaction[]): Transaction[] | null => {
      if (remaining === 0) return chosen.length >= 2 ? chosen : null;
      if (remaining < 0) return null;
      if (chosen.length >= opts.maxGroupSize) return null;

      for (let i = start; i < usable.length; i += 1) {
        const next = usable[i]!;
        const found = search(i + 1, remaining - next.amountMinor, [...chosen, next]);
        if (found) return found;
      }
      return null;
    };

    const group = search(0, single.amountMinor, []);
    if (!group) return;

    paired.add(single.id);
    for (const g of group) paired.add(g.id);
    pairs.push({
      outIds: singleIsOut ? [single.id] : group.map((g) => g.id),
      inIds: singleIsOut ? group.map((g) => g.id) : [single.id],
      amountMinor: single.amountMinor,
      mode: 'grouped',
    });
  };

  for (const out of outs) tryGrouped(out, ins, true);
  for (const inc of ins) tryGrouped(inc, outs, false);

  // ---- Apply -------------------------------------------------------------
  const updated = transactions.map((tx) => {
    if (!candidateIds.has(tx.id) || !paired.has(tx.id)) return tx;
    if (tx.kind === 'transfer-internal') return tx;
    return { ...tx, kind: 'transfer-internal' as const };
  });

  return { transactions: updated, pairs };
}
