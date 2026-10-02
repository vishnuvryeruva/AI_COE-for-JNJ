import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthStatus } from './api/client';
import type { CsRequest, Stats, Status } from './types';
import IngestPanel from './components/IngestPanel';
import MailboxPanel from './components/MailboxPanel';
import QueueTable from './components/QueueTable';
import RequestDetail from './components/RequestDetail';

const TILES: { key: Status | 'ALL'; label: string; tone: string }[] = [
  { key: 'ALL', label: 'All requests', tone: 'brand' },
  { key: 'READY', label: 'Ready to review', tone: 'ok' },
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
  const [auth, setAuth] = useState<AuthStatus>({ configured: false, signedIn: false, username: null });
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const refreshVersion = useRef(0);

  const refreshAuth = useCallback(() => {
    setAuthLoading(true);
    setAuthError(null);
    api.authStatus().then(setAuth)
      .catch(() => setAuthError('Could not check your Outlook connection. Please try again.'))
      .finally(() => setAuthLoading(false));
  }, []);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const [list, counts] = await Promise.all([
        api.listRequests(filter === 'ALL' ? {} : { status: filter }),
        api.stats(),
      ]);
      if (version === refreshVersion.current) {
        setRequests(list);
        setStats(counts);
      }
    } catch (err) {
      if (version === refreshVersion.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [filter]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    api.health().then((h) => setAiCore(h.aiCore)).catch(() => setAiCore('unknown'));
    refreshAuth();
  }, [refreshAuth]);

  const count = (key: Status | 'ALL') =>
    !stats ? '—' : key === 'ALL' ? stats.TOTAL : stats[key];

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand-lockup" href="#" onClick={(event) => { event.preventDefault(); setSelected(null); }} aria-label="AI4U Email Operations home">
          <span className="brand-mark" aria-hidden="true">ai</span>
          <span><strong>AI4U</strong><span className="brand-divider">/</span>Email Operations</span>
        </a>
        <span className="spacer" />
        {aiCore === 'stub' && <span className="badge">Basic classification</span>}
        {aiCore === 'configured' && <span className="badge">SAP AI Core connected</span>}
        {auth.configured && auth.signedIn && <span className="account-badge" title={auth.username || undefined}><span className="status-dot" />{auth.username}</span>}
      </header>

      <main className="container">
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button className="link-btn" style={{ marginLeft: 10 }} onClick={() => setError(null)}>dismiss</button>
          </div>
        )}

        {selected && (
          <RequestDetail
            key={selected}
            id={selected}
            outlookConnected={auth.configured && auth.signedIn}
            onBack={() => setSelected(null)}
            onChanged={() => void refresh()}
            onError={setError}
          />
        )}
        <div hidden={selected !== null}>
            <div className="workspace-heading">
              <div>
                <p className="eyebrow">Customer service workspace</p>
                <h1>Turn email into action.</h1>
                <p className="workspace-description">Find sales orders, invoices, and delivery requests in Outlook. Prepare replies for your team to review.</p>
              </div>
              <span className="workflow-label">Find <span>→</span> Understand <span>→</span> Review</span>
            </div>

            {authLoading && !auth.configured ? (
              <div className="panel empty" role="status">Checking Outlook connection…</div>
            ) : authError ? (
              <div className="error-banner" role="alert">
                {authError} <button className="btn sm" onClick={refreshAuth}>Retry connection</button>
              </div>
            ) : (
              <MailboxPanel
                auth={auth}
                onAuthChange={refreshAuth}
                onIngested={() => void refresh()}
                onOpenRequest={setSelected}
                onError={setError}
              />
            )}

            <div className="section-heading">
              <div><p className="eyebrow">From inbox to resolution</p><h2>Your work queue</h2></div>
              <span>Replies are reviewed before sending</span>
            </div>
            <div className="tiles">
              {TILES.map((tile) => (
                <button
                  key={tile.key}
                  className={`tile ${filter === tile.key ? 'active' : ''}`}
                  data-tone={tile.tone}
                  aria-pressed={filter === tile.key}
                  onClick={() => setFilter(tile.key)}
                >
                  <span className="label">{tile.label}</span>
                  <span className="value">{count(tile.key)}</span>
                </button>
              ))}
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2>{filter === 'ALL' ? 'All requests' : TILES.find((tile) => tile.key === filter)?.label}</h2>
                <span className="sub">
                  {requests.length} {filter === 'ALL' ? 'total' : `with status ${filter.toLowerCase().replace('_', ' ')}`}
                </span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => void refresh()}>Refresh</button>
              </div>
              <div className="table-scroll">
                <QueueTable requests={requests} filtered={filter !== 'ALL'} onOpen={setSelected} />
              </div>
            </div>

            <details className="manual-fallback">
              <summary><span>Import an email manually</span><span className="fallback-hint">.eml upload, manual entry, and sample emails</span></summary>
              <IngestPanel onIngested={() => void refresh()} onError={setError} />
            </details>
            <p className="workspace-footnote">Order references come from email content. Live SAP order data is not connected.</p>
        </div>
      </main>
    </div>
  );
}
