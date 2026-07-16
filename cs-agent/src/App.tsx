import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import type { CsRequest, Stats, Status } from './types';
import IngestPanel from './components/IngestPanel';
import QueueTable from './components/QueueTable';
import RequestDetail from './components/RequestDetail';

const TILES: { key: Status | 'ALL'; label: string; tone: string }[] = [
  { key: 'ALL', label: 'All', tone: 'brand' },
  { key: 'READY', label: 'Ready', tone: 'ok' },
  { key: 'NEEDS_REVIEW', label: 'Needs review', tone: 'warn' },
  { key: 'FAILED', label: 'Failed', tone: 'err' },
  { key: 'SENT', label: 'Sent', tone: 'brand' },
];

export default function App() {
  const [requests, setRequests] = useState<CsRequest[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Status | 'ALL'>('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiCore, setAiCore] = useState<string>('');

  const refresh = useCallback(async () => {
    try {
      const [list, counts] = await Promise.all([
        api.listRequests(filter === 'ALL' ? {} : { status: filter }),
        api.stats(),
      ]);
      setRequests(list);
      setStats(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [filter]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    api.health().then((h) => setAiCore(h.aiCore)).catch(() => setAiCore('unknown'));
  }, []);

  const count = (key: Status | 'ALL') =>
    !stats ? 0 : key === 'ALL' ? stats.TOTAL : stats[key];

  return (
    <div className="app">
      <div className="topbar">
        <h1>AI4U · CS Agent</h1>
        <span className="badge">POC 1 — ingest · intent · draft</span>
        <span className="spacer" />
        {aiCore === 'stub' && <span className="badge warn">AI Core not bound — keyword stub</span>}
        {aiCore === 'configured' && <span className="badge">AI Core connected</span>}
      </div>

      <div className="container">
        {error && (
          <div className="error-banner">
            {error}
            <button className="link-btn" style={{ marginLeft: 10 }} onClick={() => setError(null)}>dismiss</button>
          </div>
        )}

        {selected ? (
          <RequestDetail
            id={selected}
            onBack={() => setSelected(null)}
            onChanged={() => void refresh()}
            onError={setError}
          />
        ) : (
          <>
            <div className="tiles">
              {TILES.map((tile) => (
                <button
                  key={tile.key}
                  className={`tile ${filter === tile.key ? 'active' : ''}`}
                  data-tone={tile.tone}
                  onClick={() => setFilter(tile.key)}
                >
                  <div className="label">{tile.label}</div>
                  <div className="value">{count(tile.key)}</div>
                </button>
              ))}
            </div>

            <IngestPanel onIngested={() => void refresh()} onError={setError} />

            <div className="panel">
              <div className="panel-head">
                <h2>Work queue</h2>
                <span className="sub">
                  {requests.length} {filter === 'ALL' ? 'total' : `with status ${filter.toLowerCase().replace('_', ' ')}`}
                </span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => void refresh()}>Refresh</button>
              </div>
              <QueueTable requests={requests} onOpen={setSelected} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
