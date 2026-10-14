import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, AUTH_INVALIDATED_EVENT, type AuthStatus } from './api/client';
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

const AUTH_MESSAGES: Record<string, string> = {
  AUTH_NOT_CONFIGURED: 'J&J sign-in is not configured yet. Ask your workspace administrator to complete Microsoft Outlook setup.',
  AUTH_STATE_INVALID: 'Your sign-in attempt expired. Please start sign-in again.',
  AUTH_ACCESS_DENIED: 'Microsoft sign-in was cancelled or access was denied. Please try again with your J&J account.',
  AUTH_CONSENT_REQUIRED: 'Your J&J administrator needs to approve this application’s Outlook access before you can sign in.',
  AUTH_TENANT_MISMATCH: 'This workspace requires an account from your organization. Please sign in with your J&J work account.',
  AUTH_CONFIGURATION_ERROR: 'Microsoft sign-in setup needs attention. Contact your workspace administrator.',
  AUTH_UNAVAILABLE: 'Microsoft sign-in is temporarily unavailable. Please try again.',
  AUTH_FAILED: 'Microsoft sign-in could not be completed. Please try again.',
};

export default function App() {
  const [requests, setRequests] = useState<CsRequest[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Status | 'ALL'>('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiCore, setAiCore] = useState<string>('');
  const [auth, setAuth] = useState<AuthStatus>({ required: true, configured: false, signedIn: false, username: null });
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(() => {
    const code = new URLSearchParams(window.location.search).get('authError');
    return code ? Object.prototype.hasOwnProperty.call(AUTH_MESSAGES, code) ? AUTH_MESSAGES[code] : AUTH_MESSAGES.AUTH_FAILED : null;
  });
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const refreshVersion = useRef(0);
  const authVersion = useRef(0);
  const canUseWorkspace = !authLoading && !authError && (!auth.required || auth.signedIn);
  const workspaceAccess = useRef(false);
  workspaceAccess.current = Boolean(canUseWorkspace);

  const clearWorkspace = useCallback(() => {
    refreshVersion.current += 1;
    workspaceAccess.current = false;
    setRequests([]);
    setStats(null);
    setSelected(null);
    setFilter('ALL');
    setError(null);
    setWorkspaceVersion((version) => version + 1);
  }, []);

  const refreshAuth = useCallback(() => {
    const version = ++authVersion.current;
    clearWorkspace();
    setAuthLoading(true);
    setAuthError(null);
    api.authStatus().then((status) => {
      if (version === authVersion.current) setAuth({ ...status, required: status.required !== false });
    }).catch(() => {
      if (version === authVersion.current) setAuthError('Could not verify your sign-in. Please try again.');
    }).finally(() => {
      if (version === authVersion.current) setAuthLoading(false);
    });
  }, [clearWorkspace]);

  const refresh = useCallback(async () => {
    if (!workspaceAccess.current) return;
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

  useEffect(() => {
    if (canUseWorkspace) void refresh();
  }, [refresh, canUseWorkspace, auth.username]);

  useEffect(() => {
    function invalidate(event: Event) {
      authVersion.current += 1;
      clearWorkspace();
      setAuth((previous) => ({ ...previous, signedIn: false, username: null }));
      setAuthLoading(false);
      setAuthError(null);
      setAuthNotice((event as CustomEvent<string>).detail === 'expired'
        ? 'Your session has expired. Sign in with your J&J account again to continue.'
        : null);
    }
    window.addEventListener(AUTH_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(AUTH_INVALIDATED_EVENT, invalidate);
  }, [clearWorkspace]);

  useEffect(() => {
    api.health().then((h) => setAiCore(h.aiCore)).catch(() => setAiCore('unknown'));
    refreshAuth();
    const url = new URL(window.location.href);
    if (url.searchParams.has('authError')) {
      url.searchParams.delete('authError');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
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
        {authNotice && <div className="error-banner" role="alert">{authNotice}</div>}
        {authLoading ? (
          <div className="panel empty" role="status">Checking your sign-in…</div>
        ) : authError ? (
          <div className="panel sign-in-panel">
            <h1>Sign-in check unavailable</h1>
            <p role="alert">{authError}</p>
            <button className="btn primary" onClick={refreshAuth}>Retry sign-in check</button>
          </div>
        ) : auth.required && !auth.signedIn ? (
          <section className="panel sign-in-panel" aria-labelledby="sign-in-heading">
            <p className="eyebrow">J&J Email Operations</p>
            <h1 id="sign-in-heading">{auth.configured ? 'Sign in to your workspace' : 'J&J sign-in setup required'}</h1>
            <p>{auth.configured
              ? 'Use your J&J Microsoft work account to access your email work queue and connect your Outlook inbox.'
              : 'A workspace administrator needs to configure J&J Microsoft sign-in and approve Outlook access before this workspace can be used.'}</p>
            {auth.configured && <a className="btn primary" href={api.authLoginUrl}>Sign in with J&J account</a>}
            <p className="sign-in-help">{auth.configured
              ? 'Microsoft handles sign-in and your organization’s verification requirements.'
              : 'Contact your J&J workspace administrator to complete setup.'}</p>
          </section>
        ) : null}
        {canUseWorkspace && <Fragment key={workspaceVersion}>
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

            <MailboxPanel
                auth={auth}
                onAuthChange={refreshAuth}
                onIngested={() => void refresh()}
                onOpenRequest={setSelected}
                onError={setError}
            />

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
              <summary><span>Import an email manually</span><span className="fallback-hint">Outlook .msg or .eml upload, manual entry, and sample emails</span></summary>
              <IngestPanel onIngested={() => void refresh()} onError={setError} />
            </details>
            <p className="workspace-footnote">Order references come from email content. Live SAP order data is not connected.</p>
        </div>
        </Fragment>}
      </main>
    </div>
  );
}
