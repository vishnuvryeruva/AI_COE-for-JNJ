import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, AUTH_INVALIDATED_EVENT, type AuthStatus } from './api/client';
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
  const [auth, setAuth] = useState<AuthStatus>({ required: true, configured: false, signedIn: false, guest: false, guestEnabled: false, username: null });
  const [guestBusy, setGuestBusy] = useState(false);
  const [exitBusy, setExitBusy] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(() => {
    const code = new URLSearchParams(window.location.search).get('authError');
    return code ? Object.prototype.hasOwnProperty.call(AUTH_MESSAGES, code) ? AUTH_MESSAGES[code] : AUTH_MESSAGES.AUTH_FAILED : null;
  });
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const refreshVersion = useRef(0);
  const authVersion = useRef(0);
  const canUseWorkspace = !authLoading && !authError && (!auth.required || auth.signedIn || auth.guest);
  const tiles = auth.guest ? TILES.map((tile) => tile.key === 'SENT' ? { ...tile, key: 'APPROVED' as const, label: 'Approved (demo)' } : tile) : TILES;
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
      if (version === authVersion.current) setAuth({ ...status, required: status.required !== false, guest: status.guest === true, guestEnabled: status.guestEnabled === true });
    }).catch(() => {
      if (version === authVersion.current) setAuthError('Could not verify your sign-in. Please try again.');
    }).finally(() => {
      if (version === authVersion.current) setAuthLoading(false);
    });
  }, [clearWorkspace]);

  async function continueAsGuest() {
    if (guestBusy) return;
    setGuestBusy(true);
    setAuthNotice(null);
    try {
      await api.startGuest();
      refreshAuth();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'GUEST_DEMO_DISABLED') {
        setAuth((previous) => ({ ...previous, guestEnabled: false }));
        setAuthNotice('Guest demo access is currently disabled. Contact your workspace administrator.');
      } else if (err instanceof ApiError && err.code === 'GUEST_DEMO_UNAVAILABLE') {
        setAuthNotice('Guest demo setup needs attention. Contact your workspace administrator.');
      } else {
        setAuthNotice(err instanceof Error ? err.message : 'Could not start a guest demo. Please try again.');
      }
    } finally {
      setGuestBusy(false);
    }
  }

  async function exitDemo() {
    if (exitBusy) return;
    setExitBusy(true);
    try {
      await api.logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not exit the demo. Please try again.');
    } finally {
      setExitBusy(false);
    }
  }

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
      setAuth((previous) => ({ ...previous, signedIn: false, guest: false, username: null }));
      setAuthLoading(false);
      setAuthError(null);
      setAuthNotice((event as CustomEvent<string>).detail === 'expired'
        ? auth.guest
          ? 'Your guest demo session has expired. Continue as guest to start a new demo, or sign in with your J&J account.'
          : 'Your session has expired. Sign in with your J&J account again to continue.'
        : null);
    }
    window.addEventListener(AUTH_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(AUTH_INVALIDATED_EVENT, invalidate);
  }, [clearWorkspace, auth.guest]);

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
        {auth.guest && <><span className="badge guest-badge">Guest demo</span><button className="btn sm" disabled={exitBusy} onClick={() => void exitDemo()}>{exitBusy ? 'Exiting demo…' : 'Exit demo'}</button></>}
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
        ) : auth.required && !auth.signedIn && !auth.guest ? (
          <section className="panel sign-in-panel" aria-labelledby="sign-in-heading">
            <p className="eyebrow">J&J Email Operations</p>
            <h1 id="sign-in-heading">{auth.configured ? 'Sign in to your workspace' : auth.guestEnabled ? 'Explore Email Operations' : 'J&J sign-in setup required'}</h1>
            <p>{auth.configured
              ? 'Use your J&J Microsoft work account to access your email work queue and connect your Outlook inbox.'
              : auth.guestEnabled
                ? 'Try the email review workflow now with sample emails or saved Outlook files. J&J sign-in will be available when Microsoft setup is complete.'
                : 'A workspace administrator needs to configure J&J Microsoft sign-in and approve Outlook access before this workspace can be used.'}</p>
            <div className="sign-in-actions">
              {auth.configured && <a className="btn primary" href={api.authLoginUrl}>Sign in with J&J account</a>}
              {auth.guestEnabled && <button className={`btn ${auth.configured ? '' : 'primary'}`} disabled={guestBusy} onClick={() => void continueAsGuest()}>{guestBusy ? 'Starting guest demo…' : 'Continue as guest'}</button>}
            </div>
            <p className="sign-in-help">{auth.configured
              ? 'Microsoft handles sign-in and your organization’s verification requirements.'
              : auth.guestEnabled
                ? 'Guest demo: Outlook is not connected; replies are not sent.'
              : 'Contact your J&J workspace administrator to complete setup.'}</p>
          </section>
        ) : null}
        {canUseWorkspace && <Fragment key={workspaceVersion}>
        {auth.guest && <div className="callout info guest-notice">Guest demo: Outlook is not connected; replies are not sent.</div>}
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
            demoMode={auth.guest}
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
                <p className="workspace-description">{auth.guest ? 'Explore sales orders, invoices, and delivery requests with sample emails or saved Outlook files. Review and approve demo replies.' : 'Find sales orders, invoices, and delivery requests in Outlook. Prepare replies for your team to review.'}</p>
              </div>
              <span className="workflow-label">Find <span>→</span> Understand <span>→</span> Review</span>
            </div>

            {auth.guest ? <IngestPanel demoMode onIngested={() => void refresh()} onError={setError} /> : <MailboxPanel
                auth={auth}
                onAuthChange={refreshAuth}
                onIngested={() => void refresh()}
                onOpenRequest={setSelected}
                onError={setError}
            />}

            <div className="section-heading">
              <div><p className="eyebrow">From inbox to resolution</p><h2>Your work queue</h2></div>
              <span>{auth.guest ? 'Demo approvals do not send replies' : 'Replies are reviewed before sending'}</span>
            </div>
            <div className="tiles">
              {tiles.map((tile) => (
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
                <h2>{filter === 'ALL' ? 'All requests' : tiles.find((tile) => tile.key === filter)?.label}</h2>
                <span className="sub">
                  {requests.length} {filter === 'ALL' ? 'total' : `with status ${filter.toLowerCase().replace('_', ' ')}`}
                </span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => void refresh()}>Refresh</button>
              </div>
              <div className="table-scroll">
                <QueueTable requests={requests} filtered={filter !== 'ALL'} demoMode={auth.guest} onOpen={setSelected} />
              </div>
            </div>

            {!auth.guest && <details className="manual-fallback">
              <summary><span>Import an email manually</span><span className="fallback-hint">Outlook .msg or .eml upload, manual entry, and sample emails</span></summary>
              <IngestPanel onIngested={() => void refresh()} onError={setError} />
            </details>}
            <p className="workspace-footnote">Order references come from email content. Live SAP order data is not connected.</p>
        </div>
        </Fragment>}
      </main>
    </div>
  );
}
