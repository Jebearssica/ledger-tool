import { useCallback, useRef, useState } from 'react';
import {
  MIN_PASSPHRASE_LENGTH,
  buildSnapshotPayload,
  decryptSnapshot,
  encryptSnapshot,
  snapshotFileName,
  type SnapshotPayload,
} from '../crypto/snapshot';
import { DEFAULT_RULES } from '../domain/categories';
import {
  clearAllData,
  getAllTransactions,
  listAccounts,
  listBatches,
  listTemplates,
  restoreAll,
} from '../storage/db';

interface Props {
  onChanged: () => void;
}

export default function SnapshotPanel({ onChanged }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const exportSnapshot = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = buildSnapshotPayload({
        transactions: await getAllTransactions(),
        batches: await listBatches(),
        accounts: await listAccounts(),
        templates: await listTemplates(),
        rules: DEFAULT_RULES,
      });

      const bytes = await encryptSnapshot(payload, passphrase);
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = snapshotFileName();
      link.click();
      URL.revokeObjectURL(url);

      setNotice(
        `已导出 ${payload.transactions.length} 条记录，加密为 ${(bytes.length / 1024).toFixed(1)} KB。` +
          '把这个文件放进仓库是安全的 —— 没有口令谁也读不出内容。',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [passphrase]);

  const importSnapshot = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const payload = await decryptSnapshot<SnapshotPayload>(bytes, passphrase);
        await restoreAll({
          transactions: payload.transactions ?? [],
          batches: payload.batches ?? [],
          templates: payload.templates ?? [],
        });
        setNotice(
          `已恢复 ${payload.transactions?.length ?? 0} 条记录（导出于 ${payload.exportedAt?.slice(0, 10) ?? '未知日期'}）。` +
            '本地原有数据已被这份快照整体替换。',
        );
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, passphrase],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await clearAllData();
      setNotice('已清空本机全部数据。');
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const passphraseOk = passphrase.length >= MIN_PASSPHRASE_LENGTH;

  return (
    <>
      <div className="card">
        <h2>加密快照</h2>
        <p className="small muted">
          快照是 AES-256-GCM 密文，密钥由口令经 PBKDF2-SHA256（60 万次迭代）派生。口令只存在于内存中，
          永远不会写入文件、日志或 URL。正因如此，<strong>口令一旦丢失，数据无法找回</strong>。
        </p>

        <div className="field" style={{ maxWidth: 380 }}>
          <label htmlFor="snapshot-passphrase">
            口令（至少 {MIN_PASSPHRASE_LENGTH} 位）
          </label>
          <input
            id="snapshot-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="只保存在本机内存里"
            autoComplete="new-password"
          />
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            onClick={() => void exportSnapshot()}
            disabled={busy || !passphraseOk}
          >
            导出加密快照
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy || !passphraseOk}>
            从快照恢复
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".enc"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importSnapshot(file);
              e.target.value = '';
            }}
          />
        </div>

        {!passphraseOk && passphrase.length > 0 && (
          <p className="small muted">还差 {MIN_PASSPHRASE_LENGTH - passphrase.length} 位。</p>
        )}

        {error && <div className="message error">{error}</div>}
        {notice && <div className="message ok">{notice}</div>}
      </div>

      <div className="card">
        <h2>仓库里可以放什么</h2>
        <p className="small">
          这个仓库是<strong>公开</strong>的，而且 git 历史会被克隆和镜像 —— 删除一次提交并不等于抹掉它。
        </p>
        <p className="small">
          唯一允许提交的是加密快照（<code>*.enc</code>）。<strong>绝不要</strong>提交账单原文件、
          导出的 CSV / XLSX / ZIP / PDF，或任何能反推出金额的截图。
        </p>
        <p className="small muted">
          提交前运行 <code>npm run check:no-plaintext</code>：它会扫描暂存的文件，命中明文流水、
          身份证号或银行卡号时直接失败。
        </p>
        <p className="small muted">
          另外，快照采用 4 KiB 定长填充，文件大小不会暴露你某个月有多少笔消费。
        </p>
      </div>

      <div className="card">
        <h2>清空本机数据</h2>
        <p className="small muted">
          删除 IndexedDB 中的全部内容。此操作不可撤销，请先导出快照。浏览器数据被清除时也会发生同样的事。
        </p>
        <button className="btn danger" onClick={() => void reset()} disabled={busy}>
          清空全部数据
        </button>
      </div>
    </>
  );
}
