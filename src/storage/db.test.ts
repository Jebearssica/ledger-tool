import { beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from '../domain/types';
import {
  clearAllData,
  deleteBatch,
  getAllTransactions,
  getExistingFingerprints,
  getExistingRecords,
  getSetting,
  listBatches,
  openLedgerDb,
  saveImportBatch,
  setSetting,
  setTransactionCategory,
  type ImportBatch,
} from './db';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    fingerprint: 'fp_1',
    fingerprintVersion: 1,
    source: 'alipay',
    accountId: 'alipay:main',
    direction: 'out',
    amountMinor: 2850,
    currency: 'CNY',
    occurredAt: '2026-09-01T00:12:33.000Z',
    rawDescription: '午餐',
    category: 'food',
    categorySource: 'rule',
    kind: 'expense',
    importedBatchId: 'b1',
    ...overrides,
  };
}

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: 'b1',
    fileName: 'synthetic.csv',
    sourceLabel: 'Alipay',
    importedAt: '2026-09-14T00:00:00.000Z',
    inserted: 1,
    duplicates: 0,
    dropped: 0,
    notes: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAllData();
});

describe('saveImportBatch', () => {
  it('stores transactions and their batch together', async () => {
    await saveImportBatch(batch(), [tx()]);

    expect(await getAllTransactions()).toHaveLength(1);
    expect(await listBatches()).toHaveLength(1);
  });

  it('exposes fingerprints, which is what makes a re-import a no-op', async () => {
    await saveImportBatch(batch(), [tx(), tx({ id: 'tx_2', fingerprint: 'fp_2', amountMinor: 4500 })]);

    const fingerprints = await getExistingFingerprints();
    expect(fingerprints).toEqual(new Set(['fp_1', 'fp_2']));
  });

  it('exposes whole records, which is what lets a re-import correct them', async () => {
    // Membership alone can only ever skip a row; the content is what allows an
    // overlapping import to update it (AGENTS.md §5).
    await saveImportBatch(batch(), [tx({ amountMinor: 2850 })]);

    const records = await getExistingRecords();
    expect([...records.keys()]).toEqual(['fp_1']);
    expect(records.get('fp_1')!.amountMinor).toBe(2850);
    expect(records.get('fp_1')!.rawDescription).toBe('午餐');
  });

  it('returns transactions newest first', async () => {
    await saveImportBatch(batch(), [
      tx({ id: 'tx_old', fingerprint: 'fp_old', occurredAt: '2026-09-01T00:00:00.000Z' }),
      tx({ id: 'tx_new', fingerprint: 'fp_new', occurredAt: '2026-09-20T00:00:00.000Z' }),
    ]);

    expect((await getAllTransactions()).map((t) => t.id)).toEqual(['tx_new', 'tx_old']);
  });
});

describe('the unique fingerprint index', () => {
  it('rejects a second row carrying an existing fingerprint', async () => {
    // The pipeline dedupes first, so this is the last line of defence: even if a
    // caller misbehaves, storage cannot hold the same transaction twice.
    await saveImportBatch(batch(), [tx()]);

    await expect(
      saveImportBatch(
        batch({ id: 'b2' }),
        [tx({ id: 'tx_different_id', fingerprint: 'fp_1' })],
      ),
    ).rejects.toThrow();
  });

  it('updates a row in place when its id and fingerprint are unchanged', async () => {
    // The id is derived from the fingerprint, so a correction to the same
    // transaction rewrites the same record rather than colliding with it. This is
    // the mechanism the overlap update relies on.
    await saveImportBatch(batch(), [tx({ amountMinor: 15_400, kind: 'refund' })]);
    await saveImportBatch(
      batch({ id: 'b2' }),
      [tx({ amountMinor: 14_500, kind: 'expense', importedBatchId: 'b2' })],
    );

    const stored = await getAllTransactions();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.amountMinor).toBe(14_500);
    expect(stored[0]!.kind).toBe('expense');
    expect(stored[0]!.importedBatchId).toBe('b2');
  });
});

describe('deleteBatch', () => {
  it('removes the batch and everything it imported', async () => {
    await saveImportBatch(batch(), [tx()]);
    await saveImportBatch(batch({ id: 'b2' }), [
      tx({ id: 'tx_2', fingerprint: 'fp_2', importedBatchId: 'b2' }),
    ]);

    await deleteBatch('b1');

    const remaining = await getAllTransactions();
    expect(remaining.map((t) => t.id)).toEqual(['tx_2']);
    expect((await listBatches()).map((b) => b.id)).toEqual(['b2']);
  });

  it('frees the fingerprints so the same file can be re-imported', async () => {
    await saveImportBatch(batch(), [tx()]);
    await deleteBatch('b1');

    expect(await getExistingFingerprints()).toEqual(new Set());

    // Re-importing after an undo must work, not see a phantom duplicate.
    await saveImportBatch(batch(), [tx()]);
    expect(await getAllTransactions()).toHaveLength(1);
  });

  it('is a no-op for an unknown batch', async () => {
    await saveImportBatch(batch(), [tx()]);
    await deleteBatch('does-not-exist');
    expect(await getAllTransactions()).toHaveLength(1);
  });
});

describe('setTransactionCategory (AGENTS.md §7)', () => {
  it('marks the change as user-owned so rules cannot overwrite it', async () => {
    await saveImportBatch(batch(), [tx()]);

    await setTransactionCategory('tx_1', 'travel');

    const updated = (await getAllTransactions())[0]!;
    expect(updated.category).toBe('travel');
    expect(updated.categorySource).toBe('user');
  });

  it('allows clearing a category back to unset', async () => {
    await saveImportBatch(batch(), [tx()]);
    await setTransactionCategory('tx_1', undefined);

    const updated = (await getAllTransactions())[0]!;
    expect(updated.category).toBeUndefined();
    expect(updated.categorySource).toBe('user');
  });

  it('ignores an unknown transaction id', async () => {
    await expect(setTransactionCategory('nope', 'food')).resolves.toBeUndefined();
  });
});

describe('settings', () => {
  it('round-trips a value and falls back when unset', async () => {
    expect(await getSetting('theme', 'dark')).toBe('dark');
    await setSetting('theme', 'light');
    expect(await getSetting('theme', 'dark')).toBe('light');
  });

  it('stores structured values', async () => {
    await setSetting('pairing', { windowDays: 5 });
    expect(await getSetting('pairing', {})).toEqual({ windowDays: 5 });
  });
});

describe('clearAllData', () => {
  it('empties every store', async () => {
    await saveImportBatch(batch(), [tx()]);
    await setSetting('k', 'v');

    await clearAllData();

    expect(await getAllTransactions()).toEqual([]);
    expect(await listBatches()).toEqual([]);
    expect(await getExistingFingerprints()).toEqual(new Set());
    expect(await getSetting('k', null)).toBeNull();
  });
});

describe('schema', () => {
  it('creates the expected stores and indexes', async () => {
    const db = await openLedgerDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      ['accounts', 'batches', 'rules', 'settings', 'templates', 'transactions'].sort(),
    );

    const txStore = db.transaction('transactions').store;
    expect([...txStore.indexNames].sort()).toEqual(
      ['by_batch', 'by_fingerprint', 'by_kind', 'by_occurredAt'].sort(),
    );
  });
});
