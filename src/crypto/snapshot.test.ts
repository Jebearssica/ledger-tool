import { describe, expect, it } from 'vitest';
import {
  GCM_TAG_BYTES,
  PAD_BLOCK_BYTES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_MAGIC,
  buildSnapshotPayload,
  decryptSnapshot,
  encryptSnapshot,
  snapshotFileName,
  type SnapshotPayload,
} from '../crypto/snapshot';

/**
 * Tests use a deliberately tiny iteration count so the suite stays fast.
 * The production default is 600,000 (AGENTS.md §3 rule 2) and must not be
 * overridden anywhere except here.
 */
const TEST_ITERATIONS = 1000;
const PASSPHRASE = 'correct-horse-battery-staple';

const encrypt = (payload: unknown, passphrase = PASSPHRASE) =>
  encryptSnapshot(payload, passphrase, { iterations: TEST_ITERATIONS });

const samplePayload = (): SnapshotPayload =>
  buildSnapshotPayload({
    transactions: [
      {
        id: 'tx_1',
        fingerprint: 'abc123',
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
      },
    ],
    batches: [
      {
        id: 'b1',
        fileName: 'synthetic.csv',
        sourceLabel: 'Alipay',
        importedAt: '2026-09-14T00:00:00.000Z',
        inserted: 1,
        duplicates: 0,
        dropped: 0,
        notes: [],
      },
    ],
  });

describe('snapshot round trip', () => {
  it('encrypts and decrypts without losing anything', async () => {
    const payload = samplePayload();
    const restored = await decryptSnapshot<SnapshotPayload>(await encrypt(payload), PASSPHRASE);

    expect(restored.schemaVersion).toBe(payload.schemaVersion);
    expect(restored.transactions).toEqual(payload.transactions);
    expect(restored.batches).toEqual(payload.batches);
  });

  it('preserves integer amounts exactly', async () => {
    const restored = await decryptSnapshot<SnapshotPayload>(await encrypt(samplePayload()), PASSPHRASE);
    expect(restored.transactions[0]!.amountMinor).toBe(2850);
    expect(Number.isInteger(restored.transactions[0]!.amountMinor)).toBe(true);
  });

  it('handles an empty ledger', async () => {
    const empty = buildSnapshotPayload({ transactions: [] });
    const restored = await decryptSnapshot<SnapshotPayload>(await encrypt(empty), PASSPHRASE);
    expect(restored.transactions).toEqual([]);
  });
});

describe('snapshot header', () => {
  it('starts with the expected magic bytes', async () => {
    const bytes = await encrypt(samplePayload());
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe(SNAPSHOT_MAGIC);
  });

  it('records the iteration count so old files stay readable', async () => {
    const bytes = await encrypt(samplePayload());
    const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(7, false);
    expect(iterations).toBe(TEST_ITERATIONS);
  });

  it('rejects a file that is not a snapshot', async () => {
    const notASnapshot = new TextEncoder().encode('这是一个普通的文本文件，不是快照。'.repeat(4));
    await expect(decryptSnapshot(notASnapshot, PASSPHRASE)).rejects.toThrow(/magic bytes/i);
  });

  it('rejects a truncated file', async () => {
    await expect(decryptSnapshot(new Uint8Array(10), PASSPHRASE)).rejects.toThrow(/too short/i);
  });

  it('rejects an unsupported format version', async () => {
    const bytes = await encrypt(samplePayload());
    bytes[6] = 99;
    await expect(decryptSnapshot(bytes, PASSPHRASE)).rejects.toThrow(/version 99/i);
  });
});

describe('snapshot integrity', () => {
  it('fails with the wrong passphrase', async () => {
    const bytes = await encrypt(samplePayload());
    await expect(decryptSnapshot(bytes, 'wrong-passphrase-here')).rejects.toThrow(
      /passphrase is wrong|has been modified/i,
    );
  });

  it('detects a tampered ciphertext', async () => {
    const bytes = await encrypt(samplePayload());
    bytes[bytes.length - 20] ^= 0xff;
    await expect(decryptSnapshot(bytes, PASSPHRASE)).rejects.toThrow(/modified|wrong/i);
  });

  it('detects a tampered header, because the header is authenticated data', async () => {
    // Flipping the iteration count must not silently downgrade the KDF.
    const bytes = await encrypt(samplePayload());
    new DataView(bytes.buffer, bytes.byteOffset, bytes.length).setUint32(7, 10, false);
    await expect(decryptSnapshot(bytes, PASSPHRASE)).rejects.toThrow(/modified|wrong/i);
  });

  it('detects a tampered salt', async () => {
    const bytes = await encrypt(samplePayload());
    bytes[11] ^= 0xff;
    await expect(decryptSnapshot(bytes, PASSPHRASE)).rejects.toThrow(/modified|wrong/i);
  });
});

describe('passphrase policy', () => {
  it('refuses a passphrase too short to be meaningful', async () => {
    await expect(encryptSnapshot(samplePayload(), 'short')).rejects.toThrow(/at least 12 characters/i);
  });

  it('does not complain about a long passphrase', async () => {
    await expect(encrypt(samplePayload(), 'a-much-longer-passphrase')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('explains why the rule exists', async () => {
    await expect(encryptSnapshot(samplePayload(), 'short')).rejects.toThrow(/public repository/i);
  });
});

describe('metadata leakage (AGENTS.md §3 rule 6)', () => {
  it('pads every snapshot to a fixed block size', async () => {
    // Otherwise the file size would reveal how many transactions a month had.
    // The padding is bounded by the header and the GCM authentication tag.
    for (const count of [0, 1, 5, 40]) {
      const payload = buildSnapshotPayload({
        transactions: Array.from({ length: count }, (_, i) => ({
          ...samplePayload().transactions[0]!,
          id: `tx_${i}`,
          fingerprint: `fp${i}`,
        })),
      });
      const bytes = await encrypt(payload);
      const paddedLength = bytes.length - SNAPSHOT_HEADER_BYTES - GCM_TAG_BYTES;
      expect(paddedLength % PAD_BLOCK_BYTES).toBe(0);
      expect(paddedLength).toBeGreaterThan(0);
    }
  });

  it('produces different ciphertext each time for the same payload', async () => {
    // With zeros as filler and a reused IV, two identical ledgers would produce
    // identical files — a confirmation oracle for anyone holding both.
    const payload = samplePayload();
    const a = await encrypt(payload);
    const b = await encrypt(payload);
    expect(a).not.toEqual(b);
    // …and both must still decrypt to the same thing.
    expect(await decryptSnapshot(a, PASSPHRASE)).toEqual(await decryptSnapshot(b, PASSPHRASE));
  });
});

describe('snapshotFileName', () => {
  it('uses a date-stamped .enc name', () => {
    expect(snapshotFileName(new Date('2026-09-14T04:00:00.000Z'))).toBe('ledger-2026-09-14.enc');
  });
});
