import { useMemo, useState } from 'react';
import type { Transaction, TransactionKind } from '../domain/types';
import { DEFAULT_CATEGORIES } from '../domain/categories';
import { formatMinor } from '../domain/money';
import { formatShanghai, shanghaiMonth } from '../domain/dates';
import { setTransactionCategory, deleteBatch, type ImportBatch } from '../storage/db';
import { amountClass, isCashflow, kindBadgeClass, kindLabel } from './format';

interface Props {
  transactions: Transaction[];
  batches: ImportBatch[];
  onChanged: () => void;
}

const KIND_FILTERS: { value: 'all' | TransactionKind; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer-internal', label: '内部转账' },
  { value: 'transfer-investment', label: '投资转账' },
  { value: 'transfer-repayment', label: '还款' },
];

export default function TransactionList({ transactions, batches, onChanged }: Props) {
  const [month, setMonth] = useState('all');
  const [kind, setKind] = useState<'all' | TransactionKind>('all');
  const [search, setSearch] = useState('');

  const months = useMemo(() => {
    const set = new Set(transactions.map((t) => shanghaiMonth(t.occurredAt)));
    return [...set].sort().reverse();
  }, [transactions]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (month !== 'all' && shanghaiMonth(t.occurredAt) !== month) return false;
      if (kind !== 'all' && t.kind !== kind) return false;
      if (needle) {
        const haystack = `${t.rawDescription} ${t.counterparty ?? ''} ${t.category ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [transactions, month, kind, search]);

  const totals = useMemo(() => {
    const cashflow = filtered.filter(isCashflow);
    return {
      expense: cashflow.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amountMinor, 0),
      income: cashflow.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amountMinor, 0),
    };
  }, [filtered]);

  const changeCategory = async (id: string, category: string) => {
    await setTransactionCategory(id, category === '' ? undefined : category);
    onChanged();
  };

  const undoBatch = async (batchId: string) => {
    await deleteBatch(batchId);
    onChanged();
  };

  if (transactions.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          还没有任何流水。
          <br />
          <span className="small">到「导入」标签页选择一份账单文件开始。</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>筛选</h2>
        <div className="grid">
          <div className="field">
            <label htmlFor="filter-month">月份</label>
            <select id="filter-month" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">全部</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-kind">类型</label>
            <select
              id="filter-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'all' | TransactionKind)}
            >
              {KIND_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-search">搜索</label>
            <input
              id="filter-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="商户、说明或分类"
            />
          </div>
        </div>

        <div className="totals">
          <div>
            <span className="muted small">条数</span>
            <span className="value">{filtered.length}</span>
          </div>
          <div>
            <span className="muted small">支出（不含转账）</span>
            <span className="value amount expense">{formatMinor(totals.expense)}</span>
          </div>
          <div>
            <span className="muted small">收入（不含转账）</span>
            <span className="value amount income">{formatMinor(totals.income)}</span>
          </div>
          <div>
            <span className="muted small">净额</span>
            <span className="value">{formatMinor(totals.income - totals.expense)}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>明细</h2>
        <div className="table-wrap" style={{ maxHeight: 560, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>说明</th>
                <th>类型</th>
                <th>分类</th>
                <th>账户</th>
                <th className="num">金额</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 1000).map((tx) => (
                <tr key={tx.id}>
                  <td>{formatShanghai(tx.occurredAt)}</td>
                  <td>
                    {tx.rawDescription}
                    {tx.counterparty ? <span className="muted"> · {tx.counterparty}</span> : null}
                  </td>
                  <td>
                    <span className={kindBadgeClass(tx.kind)}>{kindLabel(tx.kind)}</span>
                  </td>
                  <td>
                    {tx.kind === 'expense' ? (
                      <select
                        value={tx.category ?? ''}
                        onChange={(e) => void changeCategory(tx.id, e.target.value)}
                        style={{ padding: '2px 6px', fontSize: 13 }}
                      >
                        <option value="">未分类</option>
                        {DEFAULT_CATEGORIES.filter((c) => c.appliesTo === 'expense').map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">{tx.category ?? '—'}</span>
                    )}
                  </td>
                  <td className="muted small">{tx.accountId}</td>
                  <td className={amountClass(tx.kind)}>
                    {tx.direction === 'in' ? '+' : '-'}
                    {formatMinor(tx.amountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 1000 && <p className="small muted">仅显示前 1000 条。</p>}
        <p className="small muted" style={{ marginTop: 10 }}>
          手工改过的分类会标记为用户设置，重新导入或修改规则都不会覆盖它。
        </p>
      </div>

      {batches.length > 0 && (
        <div className="card">
          <h2>导入批次</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>文件</th>
                  <th>来源</th>
                  <th className="num">新增</th>
                  <th className="num">重复</th>
                  <th className="num">排除</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{formatShanghai(batch.importedAt)}</td>
                    <td>{batch.fileName}</td>
                    <td className="muted">{batch.sourceLabel}</td>
                    <td className="num">{batch.inserted}</td>
                    <td className="num">{batch.duplicates}</td>
                    <td className="num">{batch.dropped}</td>
                    <td>
                      <button className="btn ghost" onClick={() => void undoBatch(batch.id)}>
                        撤销
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            撤销会删除该批次导入的全部记录。之后重新导入同一文件可以原样恢复。
          </p>
        </div>
      )}
    </>
  );
}
