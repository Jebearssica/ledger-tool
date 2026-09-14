import { useCallback, useEffect, useState } from 'react';
import ImportPanel from './ui/ImportPanel';
import TransactionList from './ui/TransactionList';
import SummaryPanel from './ui/SummaryPanel';
import SnapshotPanel from './ui/SnapshotPanel';
import { getAllTransactions, listBatches, type ImportBatch } from './storage/db';
import type { Transaction } from './domain/types';

type Tab = 'import' | 'transactions' | 'summary' | 'backup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'import', label: '导入' },
  { id: 'transactions', label: '明细' },
  { id: 'summary', label: '统计' },
  { id: 'backup', label: '备份' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('import');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [txs, btchs] = await Promise.all([getAllTransactions(), listBatches()]);
    setTransactions(txs);
    setBatches(btchs);
  }, []);

  useEffect(() => {
    void (async () => {
      await reload();
      setLoading(false);
    })();
  }, [reload]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>记账工具</h1>
          <span className="muted small">
            本地优先 · 无后端 · 明文不离开这台设备
          </span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              {t.label}
              {t.id === 'transactions' && transactions.length > 0 ? ` (${transactions.length})` : ''}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {loading ? (
          <div className="card">
            <div className="empty">正在读取本地数据…</div>
          </div>
        ) : (
          <>
            {tab === 'import' && (
              <ImportPanel
                onImported={() => {
                  void reload();
                }}
              />
            )}
            {tab === 'transactions' && (
              <TransactionList
                transactions={transactions}
                batches={batches}
                onChanged={() => {
                  void reload();
                }}
              />
            )}
            {tab === 'summary' && <SummaryPanel transactions={transactions} />}
            {tab === 'backup' && (
              <SnapshotPanel
                onChanged={() => {
                  void reload();
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
