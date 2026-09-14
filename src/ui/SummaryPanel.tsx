import { useMemo, useState } from 'react';
import type { Transaction } from '../domain/types';
import { DEFAULT_CATEGORIES, categoryLabel } from '../domain/categories';
import { formatMinor } from '../domain/money';
import { shanghaiMonth } from '../domain/dates';
import { isCashflow } from './format';

interface Props {
  transactions: Transaction[];
}

export default function SummaryPanel({ transactions }: Props) {
  const months = useMemo(() => {
    const set = new Set(transactions.map((t) => shanghaiMonth(t.occurredAt)));
    return [...set].sort().reverse();
  }, [transactions]);

  const [month, setMonth] = useState<string>(() => months[0] ?? '');
  const activeMonth = months.includes(month) ? month : (months[0] ?? '');

  const inMonth = useMemo(
    () => transactions.filter((t) => shanghaiMonth(t.occurredAt) === activeMonth && isCashflow(t)),
    [transactions, activeMonth],
  );

  const expense = inMonth.filter((t) => t.kind === 'expense');
  const income = inMonth.filter((t) => t.kind === 'income');

  const totalExpense = expense.reduce((s, t) => s + t.amountMinor, 0);
  const totalIncome = income.reduce((s, t) => s + t.amountMinor, 0);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of expense) {
      const key = t.category ?? '__uncategorised';
      map.set(key, (map.get(key) ?? 0) + t.amountMinor);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [expense]);

  const monthlyTrend = useMemo(() => {
    const map = new Map<string, { expense: number; income: number }>();
    for (const t of transactions) {
      if (!isCashflow(t)) continue;
      const key = shanghaiMonth(t.occurredAt);
      const entry = map.get(key) ?? { expense: 0, income: 0 };
      if (t.kind === 'expense') entry.expense += t.amountMinor;
      else entry.income += t.amountMinor;
      map.set(key, entry);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
  }, [transactions]);

  if (transactions.length === 0) {
    return (
      <div className="card">
        <div className="empty">导入流水后这里会显示统计。</div>
      </div>
    );
  }

  const maxCategory = byCategory[0]?.[1] ?? 1;

  return (
    <>
      <div className="card">
        <h2>月度收支</h2>
        <div className="field" style={{ maxWidth: 220 }}>
          <label htmlFor="summary-month">月份</label>
          <select id="summary-month" value={activeMonth} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="totals">
          <div>
            <span className="muted small">支出</span>
            <span className="value amount expense">{formatMinor(totalExpense)}</span>
          </div>
          <div>
            <span className="muted small">收入</span>
            <span className="value amount income">{formatMinor(totalIncome)}</span>
          </div>
          <div>
            <span className="muted small">结余</span>
            <span className="value">{formatMinor(totalIncome - totalExpense)}</span>
          </div>
          <div>
            <span className="muted small">支出笔数</span>
            <span className="value">{expense.length}</span>
          </div>
        </div>
        <p className="small muted">
          内部转账、投资转账与还款不计入以上任何数字 —— 它们只是钱在自己账户之间移动。
        </p>
      </div>

      <div className="card">
        <h2>分类构成 · {activeMonth}</h2>
        {byCategory.length === 0 ? (
          <p className="muted small">本月没有支出。</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>分类</th>
                  <th style={{ width: '40%' }}>占比</th>
                  <th className="num">金额</th>
                  <th className="num">占比</th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map(([id, amount]) => (
                  <tr key={id}>
                    <td>
                      {id === '__uncategorised'
                        ? '未分类'
                        : categoryLabel(id, DEFAULT_CATEGORIES)}
                    </td>
                    <td>
                      <span className="stat-bar">
                        <span style={{ width: `${Math.round((amount / maxCategory) * 100)}%` }} />
                      </span>
                    </td>
                    <td className="num amount expense">{formatMinor(amount)}</td>
                    <td className="num muted">
                      {totalExpense === 0 ? '0%' : `${Math.round((amount / totalExpense) * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginTop: 10 }}>
          分类由规则表推导；在「明细」里手工改过的分类优先级最高。
        </p>
      </div>

      {monthlyTrend.length > 1 && (
        <div className="card">
          <h2>近 12 个月</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>月份</th>
                  <th className="num">支出</th>
                  <th className="num">收入</th>
                  <th className="num">结余</th>
                </tr>
              </thead>
              <tbody>
                {monthlyTrend.map(([m, v]) => (
                  <tr key={m}>
                    <td>{m}</td>
                    <td className="num amount expense">{formatMinor(v.expense)}</td>
                    <td className="num amount income">{formatMinor(v.income)}</td>
                    <td className="num">{formatMinor(v.income - v.expense)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
