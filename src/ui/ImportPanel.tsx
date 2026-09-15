import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PDF_PASSWORD_REQUIRED } from '../importers/errors';
import { inspectFile, parseInspected, type Inspection } from '../importers/index';
import { STARTER_TEMPLATES, type Template } from '../importers/template';
import { buildTransactions, type PipelineOutcome } from '../domain/pipeline';
import { DEFAULT_RULES } from '../domain/categories';
import { formatMinor } from '../domain/money';
import { formatShanghai } from '../domain/dates';
import {
  getExistingFingerprints,
  putTemplate,
  saveImportBatch,
  type ImportBatch,
} from '../storage/db';
import { amountClass, isCashflow, kindBadgeClass, kindLabel, refundNettedNote } from './format';

type ImporterChoice = 'auto' | 'alipay' | 'wechat' | 'generic';

interface Props {
  onImported: () => void;
}

/** Fields the mapper offers. `date` is the only one with no sensible default. */
const MAPPABLE_FIELDS: { key: keyof Template['columns']; label: string; hint: string }[] = [
  { key: 'date', label: '交易日期', hint: '必填' },
  { key: 'amount', label: '金额（单列，带正负号）', hint: '' },
  { key: 'income', label: '收入/贷方（进账列）', hint: '' },
  { key: 'expense', label: '支出/借方（出账列）', hint: '' },
  { key: 'direction', label: '收/支 标志列', hint: '' },
  { key: 'balance', label: '余额', hint: '有则去重更准' },
  { key: 'counterparty', label: '对方/商户', hint: '' },
  { key: 'description', label: '摘要/备注', hint: '' },
  { key: 'status', label: '交易状态', hint: '' },
  { key: 'orderId', label: '交易单号', hint: '' },
  { key: 'txType', label: '交易类型', hint: '' },
  { key: 'method', label: '支付方式', hint: '' },
];

export default function ImportPanel({ onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [outcome, setOutcome] = useState<PipelineOutcome | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pdfPassword, setPdfPassword] = useState('');
  const [accountId, setAccountId] = useState('main');
  const [choice, setChoice] = useState<ImporterChoice>('auto');
  const [template, setTemplate] = useState<Template>(() => ({ ...STARTER_TEMPLATES[0]! }));
  const [dragging, setDragging] = useState(false);
  const bytesRef = useRef<Uint8Array | null>(null);
  const fileNameRef = useRef('');

  const persistTemplate = useCallback(async () => {
    await putTemplate(template);
  }, [template]);

  const runInspection = useCallback(
    async (bytes: Uint8Array, fileName: string, password?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      setOutcome(null);
      setNeedsPassword(false);
      try {
        const result = await inspectFile({
          fileName,
          bytes,
          ...(password ? { pdfPassword: password } : {}),
        });
        setInspection(result);
        setAccountId(`${result.detectedPlatform ?? 'bank'}:main`);
      } catch (err) {
        if (err instanceof Error && err.name === PDF_PASSWORD_REQUIRED) {
          setNeedsPassword(true);
          setNotice('这份 PDF 已加密。请输入密码（通常是身份证号或卡号后 6 位）。密码只留在内存里，不会被保存。');
          return;
        }
        setInspection(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleFile = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      bytesRef.current = bytes;
      fileNameRef.current = file.name;
      setPdfPassword('');
      await runInspection(bytes, file.name);
    },
    [runInspection],
  );

  const retryWithPassword = useCallback(async () => {
    const bytes = bytesRef.current;
    if (!bytes) return;
    await runInspection(bytes, fileNameRef.current, pdfPassword);
  }, [pdfPassword, runInspection]);

  // Re-derive the preview whenever the interpretation changes. Running the real
  // pipeline here (rather than an approximation) means what the user confirms is
  // exactly what gets stored.
  useEffect(() => {
    if (!inspection) return;

    let cancelled = false;

    const preview = async () => {
      const effective = choice === 'auto' ? inspection.detectedPlatform : choice;
      if (!effective || effective === 'generic') {
        if (!template.columns.date) {
          setOutcome(null);
          return;
        }
      }

      try {
        const parsed = parseInspected(inspection, {
          accountId,
          template,
          ...(choice === 'auto' ? {} : { force: choice as 'alipay' | 'wechat' | 'generic' }),
        });
        const existing = await getExistingFingerprints();
        const result = buildTransactions(parsed.drafts, {
          batchId: 'preview',
          rules: DEFAULT_RULES,
          existingFingerprints: existing,
        });
        if (!cancelled) {
          setOutcome(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setOutcome(null);
          // A missing template is an expected state, not an error.
          const message = err instanceof Error ? err.message : String(err);
          setError(/column mapping is needed/i.test(message) ? null : message);
        }
      }
    };

    void preview();
    return () => {
      cancelled = true;
    };
  }, [inspection, template, accountId, choice]);

  const confirmImport = useCallback(async () => {
    if (!inspection || !outcome || outcome.transactions.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const batch: ImportBatch = {
        id: `batch_${Date.now().toString(36)}`,
        fileName: inspection.fileName,
        sourceLabel: inspection.detectedPlatform ?? 'generic',
        importedAt: new Date().toISOString(),
        inserted: outcome.transactions.length,
        duplicates: outcome.duplicates.length,
        dropped: outcome.dropped.length,
        notes: inspection.notes,
      };

      const stamped = outcome.transactions.map((tx) => ({ ...tx, importedBatchId: batch.id }));
      await saveImportBatch(batch, stamped);
      await persistTemplate();

      setNotice(
        `已导入 ${stamped.length} 条。` +
          (outcome.duplicates.length > 0 ? `跳过重复 ${outcome.duplicates.length} 条。` : '') +
          (outcome.dropped.length > 0 ? `排除 ${outcome.dropped.length} 条（已关闭/退款抵扣/重复）。` : ''),
      );
      setInspection(null);
      setOutcome(null);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [inspection, onImported, outcome, persistTemplate]);

  const totals = useMemo(() => {
    if (!outcome) return null;
    const cashflow = outcome.transactions.filter(isCashflow);
    return {
      expense: cashflow.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amountMinor, 0),
      income: cashflow.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amountMinor, 0),
      transfers: outcome.transactions.length - cashflow.length,
    };
  }, [outcome]);

  const effectiveImporter = inspection
    ? choice === 'auto'
      ? inspection.detectedPlatform
      : choice
    : null;

  return (
    <div className="card">
      <h2>导入流水</h2>
      <p className="muted small">
        文件不会上传到任何服务器 —— 解析全部在你的设备上完成。
      </p>

      <div
        className={`drop-zone${dragging ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void handleFile(file);
        }}
        onClick={() => document.getElementById('file-input')?.click()}
      >
        <strong>选择或拖入账单文件</strong>
        <span className="muted small">
          支持支付宝 CSV、微信 CSV/XLSX、银行 CSV/TXT/XLS/XLSX/PDF，以及它们所在的 .zip
        </span>
        <input
          id="file-input"
          type="file"
          hidden
          accept=".csv,.txt,.tsv,.xls,.xlsx,.pdf,.zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {busy && <p className="muted small">处理中…</p>}

      {needsPassword && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row">
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="pdf-password">PDF 密码</label>
              <input
                id="pdf-password"
                type="password"
                value={pdfPassword}
                onChange={(e) => setPdfPassword(e.target.value)}
                placeholder="仅保存在本次会话内存中"
              />
            </div>
            <button className="btn primary" onClick={() => void retryWithPassword()} disabled={busy}>
              解密并读取
            </button>
          </div>
        </div>
      )}

      {error && <div className="message error">{error}</div>}
      {notice && <div className="message ok">{notice}</div>}

      {inspection && (
        <>
          <div className="card" style={{ marginTop: 14 }}>
            <h2>识别结果</h2>
            <p className="small">
              <strong>{inspection.fileName}</strong> — 容器 <code>{inspection.container}</code>，编码{' '}
              <code>{inspection.encoding}</code>
              {effectiveImporter ? (
                <>
                  ，识别为 <strong>{effectiveImporter}</strong> 导出
                </>
              ) : (
                <>，未识别来源，需要手动映射列</>
              )}
            </p>

            <ol className="steps">
              {inspection.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>

            {inspection.notes.length > 0 && (
              <div className="message warn">
                <strong>注意</strong>
                <ul>
                  {inspection.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>
            )}

            {inspection.pdf && (
              <p className="small muted">
                PDF 共 {inspection.pdf.pageCount} 页，读取 {inspection.pdf.pagesRead} 页，列一致性{' '}
                {Math.round(inspection.pdf.columnConsistency * 100)}%。
                {inspection.pdf.columnConsistency < 0.9 &&
                  ' 列一致性偏低，说明表格重建可能出错，请逐行核对后再导入。'}
              </p>
            )}

            <details>
              <summary>表头与设置</summary>
              <div className="grid" style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="account-id">账户标识</label>
                  <input
                    id="account-id"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="importer">解析器</label>
                  <select
                    id="importer"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value as ImporterChoice)}
                  >
                    <option value="auto">
                      自动{inspection.detectedPlatform ? `（${inspection.detectedPlatform}）` : ''}
                    </option>
                    <option value="alipay">强制支付宝</option>
                    <option value="wechat">强制微信</option>
                    <option value="generic">通用模板</option>
                  </select>
                </div>
              </div>
              <p className="small muted" style={{ marginTop: 10, wordBreak: 'break-all' }}>
                实际表头：{inspection.header.filter((c) => c !== '').join(' | ') || '(未找到)'}
              </p>
            </details>

            {(!effectiveImporter || effectiveImporter === 'generic') && (
              <details open>
                <summary>列映射（银行 / 券商 / 未知来源）</summary>
                <p className="small muted">
                  把文件里的列名指到对应字段上。版本号会随模板一起保存，之后同一家银行的旧文件仍按旧映射解析。
                </p>
                <div className="grid" style={{ marginTop: 10 }}>
                  {MAPPABLE_FIELDS.map(({ key, label, hint }) => (
                    <div className="field" key={key}>
                      <label htmlFor={`map-${key}`}>
                        {label} {hint && <span className="muted">· {hint}</span>}
                      </label>
                      <select
                        id={`map-${key}`}
                        value={template.columns[key] ?? ''}
                        onChange={(e) =>
                          setTemplate((prev) => ({
                            ...prev,
                            columns: { ...prev.columns, [key]: e.target.value || undefined },
                          }))
                        }
                      >
                        <option value="">（不使用）</option>
                        {inspection.header
                          .filter((c) => c !== '')
                          .map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                      </select>
                    </div>
                  ))}
                  <div className="field">
                    <label htmlFor="amount-mode">金额正负含义</label>
                    <select
                      id="amount-mode"
                      value={template.amountMode ?? 'signed'}
                      onChange={(e) =>
                        setTemplate((prev) => ({
                          ...prev,
                          amountMode: e.target.value as Template['amountMode'],
                        }))
                      }
                    >
                      <option value="signed">负数=支出，正数=收入</option>
                      <option value="positive-is-expense">正数=支出（单金额列）</option>
                      <option value="positive-is-income">正数=收入</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="template-id">模板版本号</label>
                    <input
                      id="template-id"
                      value={template.id}
                      onChange={(e) => setTemplate((prev) => ({ ...prev, id: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="template-label">模板名称</label>
                    <input
                      id="template-label"
                      value={template.label}
                      onChange={(e) => setTemplate((prev) => ({ ...prev, label: e.target.value }))}
                    />
                  </div>
                </div>
              </details>
            )}
          </div>

          {outcome && (
            <div className="card" style={{ marginTop: 14 }}>
              <h2>导入预览</h2>
              <p className="small muted">
                这是确认前的完整结果。此处的数字就是入库后的数字。
              </p>

              <div className="totals">
                <div>
                  <span className="muted small">新增</span>
                  <span className="value">{outcome.transactions.length}</span>
                </div>
                <div>
                  <span className="muted small">重复跳过</span>
                  <span className="value">{outcome.duplicates.length}</span>
                </div>
                <div>
                  <span className="muted small">排除</span>
                  <span className="value">{outcome.dropped.length}</span>
                </div>
                {totals && (
                  <>
                    <div>
                      <span className="muted small">支出</span>
                      <span className="value amount expense">{formatMinor(totals.expense)}</span>
                    </div>
                    <div>
                      <span className="muted small">收入</span>
                      <span className="value amount income">{formatMinor(totals.income)}</span>
                    </div>
                    <div>
                      <span className="muted small">转账（不计收支）</span>
                      <span className="value">{totals.transfers}</span>
                    </div>
                  </>
                )}
              </div>

              {outcome.warnings.length > 0 && (
                <div className="message warn">
                  <strong>以下行未被解析</strong>
                  <ul>
                    {outcome.warnings.slice(0, 8).map((w, i) => (
                      <li key={i}>
                        {w.row ? `第 ${w.row} 行：` : ''}
                        {w.message}
                      </li>
                    ))}
                  </ul>
                  {outcome.warnings.length > 8 && (
                    <p className="small">…以及另外 {outcome.warnings.length - 8} 条。</p>
                  )}
                </div>
              )}

              <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>说明</th>
                      <th>类型</th>
                      <th>分类</th>
                      <th className="num">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.transactions.slice(0, 200).map((tx) => (
                      <tr key={tx.id}>
                        <td>{formatShanghai(tx.occurredAt)}</td>
                        <td>
                          {tx.rawDescription}
                          {tx.counterparty ? <span className="muted"> · {tx.counterparty}</span> : null}
                          {refundNettedNote(tx.meta) ? (
                            <span className="muted"> · {refundNettedNote(tx.meta)}</span>
                          ) : null}
                        </td>
                        <td>
                          <span className={kindBadgeClass(tx.kind)}>{kindLabel(tx.kind)}</span>
                        </td>
                        <td className="muted">{tx.category ?? '—'}</td>
                        <td className={amountClass(tx.kind)}>{formatMinor(tx.amountMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {outcome.transactions.length > 200 && (
                <p className="small muted">仅显示前 200 条，其余同样会被导入。</p>
              )}

              {outcome.pairs.length > 0 && (
                <details>
                  <summary>识别到 {outcome.pairs.length} 组内部转账（已从收支中剔除）</summary>
                  <ul className="small muted">
                    {outcome.pairs.map((pair, i) => (
                      <li key={i}>
                        {formatMinor(pair.amountMinor)} — {pair.outIds.length} 笔转出对 {pair.inIds.length}{' '}
                        笔转入
                        {pair.mode === 'grouped' ? '（拆分匹配）' : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {outcome.dropped.length > 0 && (
                <details>
                  <summary>被排除的 {outcome.dropped.length} 行</summary>
                  <ul className="small muted">
                    {outcome.dropped.slice(0, 20).map((d, i) => (
                      <li key={i}>
                        {formatShanghai(d.preview.occurredAt)} · {formatMinor(d.preview.amountMinor)} ·{' '}
                        {d.preview.description} — {d.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="row" style={{ marginTop: 14 }}>
                <button
                  className="btn primary"
                  onClick={() => void confirmImport()}
                  disabled={busy || outcome.transactions.length === 0}
                >
                  确认导入 {outcome.transactions.length} 条
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setInspection(null);
                    setOutcome(null);
                    setNotice(null);
                  }}
                >
                  取消
                </button>
                {outcome.transactions.length === 0 && outcome.duplicates.length > 0 && (
                  <span className="muted small">这份文件此前已经导入过，没有新增内容。</span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
