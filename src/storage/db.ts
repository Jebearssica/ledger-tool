/**
 * IndexedDB persistence. See AGENTS.md §2, §3.
 *
 * Everything lives on the user's device. There is no server, so this is the
 * only durable copy until the user exports an encrypted snapshot.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CategoryRule } from '../domain/categories';
import type { Transaction } from '../domain/types';
import type { Template } from '../importers/template';

export const DB_NAME = 'ledger-tool';
export const DB_VERSION = 1;

export interface ImportBatch {
  id: string;
  fileName: string;
  sourceLabel: string;
  importedAt: string;
  inserted: number;
  duplicates: number;
  dropped: number;
  notes: string[];
}

export interface AccountRecord {
  /** e.g. `alipay:main`, `cmb:debit` — must be stable across imports. */
  id: string;
  label: string;
  source: string;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

interface LedgerSchema extends DBSchema {
  transactions: {
    key: string;
    value: Transaction;
    indexes: {
      by_occurredAt: string;
      by_fingerprint: string;
      by_batch: string;
      by_kind: string;
    };
  };
  batches: { key: string; value: ImportBatch };
  accounts: { key: string; value: AccountRecord };
  templates: { key: string; value: Template };
  rules: { key: string; value: CategoryRule };
  settings: { key: string; value: SettingRecord };
}

export type LedgerDb = IDBPDatabase<LedgerSchema>;

let dbPromise: Promise<LedgerDb> | null = null;

export function openLedgerDb(): Promise<LedgerDb> {
  if (!dbPromise) {
    dbPromise = openDB<LedgerSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('transactions')) {
          const store = db.createObjectStore('transactions', { keyPath: 'id' });
          store.createIndex('by_occurredAt', 'occurredAt');
          store.createIndex('by_fingerprint', 'fingerprint', { unique: true });
          store.createIndex('by_batch', 'importedBatchId');
          store.createIndex('by_kind', 'kind');
        }
        if (!db.objectStoreNames.contains('batches')) {
          db.createObjectStore('batches', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('accounts')) {
          db.createObjectStore('accounts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('templates')) {
          db.createObjectStore('templates', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('rules')) {
          db.createObjectStore('rules', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/** Test helper: drop the cached connection so a fresh database can be opened. */
export async function resetLedgerDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
  }
  dbPromise = null;
}

export async function getAllTransactions(): Promise<Transaction[]> {
  const db = await openLedgerDb();
  const all = await db.getAll('transactions');
  return all.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

/**
 * Fingerprints of everything already stored.
 *
 * This is the dedupe input: the pipeline skips any row whose fingerprint is in
 * this set, which is what makes re-importing a file a no-op.
 *
 * Note `IDBIndex.getAllKeys()` returns the records' PRIMARY keys, not the index
 * keys, so a key cursor is used to read the fingerprint values themselves.
 */
export async function getExistingFingerprints(): Promise<Set<string>> {
  const db = await openLedgerDb();
  const tx = db.transaction('transactions', 'readonly');
  const fingerprints = new Set<string>();

  let cursor = await tx.store.index('by_fingerprint').openKeyCursor();
  while (cursor) {
    fingerprints.add(String(cursor.key));
    cursor = await cursor.continue();
  }

  await tx.done;
  return fingerprints;
}

export async function getTransactionsByBatch(batchId: string): Promise<Transaction[]> {
  const db = await openLedgerDb();
  return db.getAllFromIndex('transactions', 'by_batch', batchId);
}

/**
 * Persist a batch and its transactions atomically.
 *
 * Both writes share one transaction so a crash cannot leave rows without their
 * provenance, which would make "undo this import" impossible.
 *
 * `tx.done` is observed even on failure: when a write rejects (for example, when
 * the unique fingerprint index rejects a duplicate) IndexedDB also aborts the
 * transaction, and an unobserved rejection there would surface as a stray
 * unhandled error rather than the useful one.
 */
export async function saveImportBatch(batch: ImportBatch, transactions: readonly Transaction[]): Promise<void> {
  const db = await openLedgerDb();
  const tx = db.transaction(['batches', 'transactions'], 'readwrite');
  const completion = tx.done.then(
    () => null,
    (error: unknown) => error,
  );

  let failure: unknown = null;
  try {
    await tx.objectStore('batches').put(batch);
    const store = tx.objectStore('transactions');
    for (const record of transactions) await store.put(record);
  } catch (error) {
    failure = error;
  }

  const abortError = await completion;
  if (failure) throw failure;
  if (abortError) throw abortError;
}

/**
 * Undo an import. Safe because fingerprints are derived from the source rows,
 * so a subsequent re-import reproduces exactly the same set.
 */
export async function deleteBatch(batchId: string): Promise<void> {
  const db = await openLedgerDb();
  const tx = db.transaction(['batches', 'transactions'], 'readwrite');
  const completion = tx.done.then(
    () => null,
    (error: unknown) => error,
  );

  let failure: unknown = null;
  try {
    await tx.objectStore('batches').delete(batchId);

    const store = tx.objectStore('transactions');
    let cursor = await store.index('by_batch').openCursor(batchId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  } catch (error) {
    failure = error;
  }

  const abortError = await completion;
  if (failure) throw failure;
  if (abortError) throw abortError;
}

export async function listBatches(): Promise<ImportBatch[]> {
  const db = await openLedgerDb();
  const all = await db.getAll('batches');
  return all.sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

/**
 * Apply a manual category change.
 *
 * `categorySource` is set to `user` so that nothing — not a re-import, not a
 * rule edit — can silently undo the user's correction (AGENTS.md §7).
 */
export async function setTransactionCategory(id: string, category: string | undefined): Promise<void> {
  const db = await openLedgerDb();
  const existing = await db.get('transactions', id);
  if (!existing) return;
  await db.put('transactions', { ...existing, category, categorySource: 'user' });
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const db = await openLedgerDb();
  return db.getAll('accounts');
}

export async function putAccount(record: AccountRecord): Promise<void> {
  const db = await openLedgerDb();
  await db.put('accounts', record);
}

export async function listTemplates(): Promise<Template[]> {
  const db = await openLedgerDb();
  return db.getAll('templates');
}

export async function putTemplate(template: Template): Promise<void> {
  const db = await openLedgerDb();
  await db.put('templates', template);
}

export async function deleteTemplate(id: string): Promise<void> {
  const db = await openLedgerDb();
  await db.delete('templates', id);
}

export async function listRules(): Promise<CategoryRule[]> {
  const db = await openLedgerDb();
  return db.getAll('rules');
}

export async function replaceRules(rules: readonly CategoryRule[]): Promise<void> {
  const db = await openLedgerDb();
  const tx = db.transaction('rules', 'readwrite');
  await tx.store.clear();
  for (const rule of rules) await tx.store.put(rule);
  await tx.done;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await openLedgerDb();
  const record = await db.get('settings', key);
  return record ? (record.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await openLedgerDb();
  await db.put('settings', { key, value });
}

/** Wipe everything. Used by "reset" and by tests. */
export async function clearAllData(): Promise<void> {
  const db = await openLedgerDb();
  const tx = db.transaction(
    ['transactions', 'batches', 'accounts', 'templates', 'rules', 'settings'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('transactions').clear(),
    tx.objectStore('batches').clear(),
    tx.objectStore('accounts').clear(),
    tx.objectStore('templates').clear(),
    tx.objectStore('rules').clear(),
    tx.objectStore('settings').clear(),
  ]);
  await tx.done;
}

export interface RestorePayload {
  transactions: readonly Transaction[];
  batches?: readonly ImportBatch[];
  templates?: readonly Template[];
}

/**
 * Replace the entire local database with a decrypted snapshot.
 *
 * A full replace is correct rather than a merge: the user has a single device
 * (AGENTS.md §2), so there is no concurrent writer to reconcile and no merge
 * strategy to get wrong.
 */
export async function restoreAll(payload: RestorePayload): Promise<void> {
  const db = await openLedgerDb();
  const tx = db.transaction(['transactions', 'batches', 'templates'], 'readwrite');
  const completion = tx.done.then(
    () => null,
    (error: unknown) => error,
  );

  let failure: unknown = null;
  try {
    const transactionStore = tx.objectStore('transactions');
    const batchStore = tx.objectStore('batches');
    const templateStore = tx.objectStore('templates');

    await Promise.all([transactionStore.clear(), batchStore.clear(), templateStore.clear()]);

    for (const record of payload.transactions) await transactionStore.put(record);
    for (const record of payload.batches ?? []) await batchStore.put(record);
    for (const record of payload.templates ?? []) await templateStore.put(record);
  } catch (error) {
    failure = error;
  }

  const abortError = await completion;
  if (failure) throw failure;
  if (abortError) throw abortError;
}
