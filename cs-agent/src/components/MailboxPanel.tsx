import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type AuthStatus, type MailboxSearchResult } from '../api/client';
import { formatDate } from '../lib/format';
import type { Status } from '../types';
import './MailboxPanel.css';

interface Props {
  auth: AuthStatus;
  onAuthChange: () => void;
  onIngested: () => void;
  onError: (message: string) => void;
  onOpenRequest?: (id: string) => void;
}

interface Preparation {
  requestId?: string;
  deduped?: boolean;
  status?: Status;
  error?: string;
}

const EXAMPLES = [
  { label: 'Sales orders', prompt: 'Find sales orders from email' },
  { label: 'Invoices', prompt: 'Find invoice requests from email' },
  { label: 'Packing lists', prompt: 'Find packing list requests from email' },
  { label: 'Deliveries', prompt: 'Find delivery status requests from email' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function MailboxPanel({ auth, onAuthChange, onIngested, onError, onOpenRequest }: Props) {
  const [prompt, setPrompt] = useState(EXAMPLES[0].prompt);
  const [result, setResult] = useState<MailboxSearchResult | null>(null);
  const [operation, setOperation] = useState<'search' | 'prepare' | 'logout' | null>(null);
  const [activeMessage, setActiveMessage] = useState<string | null>(null);
  const [preparations, setPreparations] = useState<Record<string, Preparation>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const connected = auth.configured && auth.signedIn && !expired;
  const busy = operation !== null;

  // A mailbox change invalidates results and any in-flight response from the previous account.
  useEffect(() => {
    generation.current += 1;
    locked.current = false;
    setResult(null);
    setPreparations({});
    setError(null);
    setNotice(null);
    setExpired(false);
    setOperation(null);
    setActiveMessage(null);
    return () => {
      generation.current += 1;
      searchController.current?.abort();
    };
  }, [auth.configured, auth.signedIn, auth.username]);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      setExpired(true);
      setResult(null);
      setPreparations({});
      setError('Your Outlook session has expired. Connect Outlook again to continue.');
      return true;
    }
    if (err instanceof ApiError && err.code === 'OUTLOOK_NOT_CONFIGURED') {
      setResult(null);
      onAuthChange();
    }
    return false;
  }

  function updatePrompt(value: string) {
    setPrompt(value);
    setResult(null);
    setError(null);
    setNotice(null);
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !connected || !prompt.trim()) return;
    locked.current = true;
    const current = generation.current;
    const controller = new AbortController();
    searchController.current = controller;
    setOperation('search');
    setResult(null);
    setError(null);
    setNotice(null);
    try {
      const found = await api.searchMailbox(prompt.trim(), controller.signal);
      if (current === generation.current) setResult(found);
    } catch (err) {
      if (current === generation.current && !controller.signal.aborted && !handleAuthError(err)) {
        setError(errorMessage(err));
      }
    } finally {
      if (current === generation.current) {
        locked.current = false;
        setOperation(null);
      }
    }
  }

  async function prepare(ids: string[]) {
    if (locked.current || !connected) return;
    const pending = [...new Set(ids)].filter((id) => !preparations[id]?.requestId);
    if (!pending.length) return;
    locked.current = true;
    const current = generation.current;
    setOperation('prepare');
    setError(null);
    setNotice(null);
    let prepared = 0;
    let existing = 0;
    let failed = 0;
    let changed = false;
    let authFailed = false;
    try {
      for (const id of pending) {
        if (current !== generation.current) return;
        setActiveMessage(id);
        setPreparations((previous) => ({ ...previous, [id]: {} }));
        try {
          const response = await api.ingestInboxMessage(id);
          if (current !== generation.current) return;
          const request = response.request;
          changed = true;
          if (request.status === 'FAILED') failed += 1;
          else if (response.deduped) existing += 1;
          else prepared += 1;
          setPreparations((previous) => ({
            ...previous,
            [id]: {
              requestId: request.id,
              deduped: response.deduped,
              status: request.status,
              error: request.status === 'FAILED' ? request.statusReason || 'Draft preparation failed. Open the request to review and retry.' : undefined,
            },
          }));
        } catch (err) {
          if (current !== generation.current) return;
          if (handleAuthError(err)) {
            authFailed = true;
            break;
          }
          failed += 1;
          setPreparations((previous) => ({ ...previous, [id]: { error: errorMessage(err) } }));
        }
      }
      if (current === generation.current && !authFailed) {
        const summary = [
          prepared ? `${prepared} ${prepared === 1 ? 'draft prepared' : 'drafts prepared'}` : '',
          existing ? `${existing} already in the work queue` : '',
          failed ? `${failed} ${failed === 1 ? 'email needs' : 'emails need'} attention` : '',
        ].filter(Boolean).join(' · ');
        setNotice(`${summary}. Review each draft before sending.`);
      }
    } finally {
      if (current === generation.current) {
        locked.current = false;
        setOperation(null);
        setActiveMessage(null);
        if (changed) onIngested();
      }
    }
  }

  async function signOut() {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setOperation('logout');
    setError(null);
    try {
      await api.logout();
      if (current === generation.current) {
        setResult(null);
        setPreparations({});
        setNotice(null);
        setExpired(true);
      }
    } catch (err) {
      if (current === generation.current) onError(errorMessage(err));
    } finally {
      if (current === generation.current) {
        locked.current = false;
        setOperation(null);
      }
    }
  }

  const pendingIds = result?.messages.filter((message) => !preparations[message.id]?.requestId).map((message) => message.id) || [];

  return (
    <section className="mailbox-command" aria-labelledby="mailbox-heading">
      <div className="mailbox-topline">
        <div className="mailbox-brand"><span className="mailbox-icon"><MailIcon /></span><span>Outlook workspace</span></div>
        <div className="mailbox-account">
          <span className={`mailbox-connection ${connected ? 'is-connected' : ''}`}>
            <span aria-hidden="true" />{connected ? 'Connected' : auth.configured ? 'Not connected' : 'Setup required'}
          </span>
          {connected && <span className="mailbox-username" title={auth.username || undefined}>{auth.username}</span>}
          {connected && <button type="button" className="mailbox-text-button" disabled={busy} onClick={() => void signOut()}>{operation === 'logout' ? 'Signing out…' : 'Sign out'}</button>}
        </div>
      </div>

      <div className="mailbox-search-area">
        <div className="mailbox-eyebrow">EMAIL TO SAP WORKFLOW</div>
        <h2 id="mailbox-heading">What should we find in Outlook?</h2>
        <p className="mailbox-description">Find sales orders and customer requests in your inbox, then prepare replies for review.</p>

        <form onSubmit={(event) => void search(event)} className="mailbox-search-form">
          <label htmlFor="mailbox-prompt" className="mailbox-prompt-label">Describe the emails to find</label>
          <div className="mailbox-prompt-box">
            <span className="mailbox-search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" /><path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span>
            <textarea id="mailbox-prompt" value={prompt} onChange={(event) => updatePrompt(event.target.value)} disabled={busy} rows={2} maxLength={500} aria-describedby="mailbox-query-help" />
            <button type="submit" className="mailbox-primary mailbox-search-button" disabled={!connected || busy || !prompt.trim()}>
              {operation === 'search' ? 'Finding emails…' : 'Find emails'}<span aria-hidden="true">↗</span>
            </button>
          </div>
          <div className="mailbox-examples"><span>Try a request</span>{EXAMPLES.map((example) => (
            <button key={example.label} type="button" aria-pressed={prompt === example.prompt} disabled={busy} onClick={() => updatePrompt(example.prompt)}>{example.label}</button>
          ))}</div>
          <p id="mailbox-query-help" className="mailbox-query-help">Add an order number, a sender, or a time range such as “this week”. Matches use email subjects and message bodies.</p>
        </form>

        {!connected && (
          <div className="mailbox-connect-card">
            <span className="mailbox-connect-icon"><MailIcon /></span>
            <div>
              <h3>{!auth.configured ? 'Outlook setup required' : expired ? 'Reconnect your Outlook mailbox' : 'Connect your Outlook mailbox'}</h3>
              <p>{!auth.configured ? 'A workspace administrator needs to configure the Microsoft Outlook connection before inbox search is available.' : 'Sign in with your J&J Microsoft work account to find real emails and prepare draft replies.'}</p>
            </div>
            {auth.configured && <a className="mailbox-primary" href={api.authLoginUrl}>Connect Outlook<span aria-hidden="true">↗</span></a>}
          </div>
        )}

        {error && <div className="mailbox-feedback is-error" role="alert">{error}</div>}
        {notice && <div className="mailbox-feedback" role="status">{notice}</div>}
        {operation === 'search' && <div className="mailbox-searching" role="status"><span className="mailbox-spinner" aria-hidden="true" />Searching your Outlook inbox for matching requests…</div>}
      </div>

      {result && (
        <div className="mailbox-results" aria-busy={operation === 'prepare'}>
          <div className="mailbox-results-heading">
            <div><div className="mailbox-eyebrow">SEARCH RESULTS</div><h3>Matching emails <span className="mailbox-count">{result.messages.length}</span></h3><p>{result.query.label} · {result.scanned} {result.scanned === 1 ? 'email' : 'emails'} checked</p></div>
            {result.messages.length > 0 && <button type="button" className="mailbox-secondary" disabled={busy || pendingIds.length === 0} onClick={() => void prepare(pendingIds)}>{operation === 'prepare' ? 'Preparing drafts…' : pendingIds.length === 0 ? 'All emails processed' : 'Prepare all drafts'}</button>}
          </div>
          <p className="mailbox-scope">{result.scope}{result.limited ? ' Search limit reached; older emails may not have been checked.' : ''}</p>
          {result.messages.length === 0 ? (
            <div className="mailbox-no-results"><span className="mailbox-empty-icon"><MailIcon /></span><h4>No matching emails found</h4><p>Try a different request, order number, or time range. Only the searched inbox messages are included.</p></div>
          ) : (
            <div className="mailbox-message-list">
              {result.messages.map((message) => {
                const preparation = preparations[message.id];
                const isPreparing = activeMessage === message.id;
                const completedLabel = preparation?.status === 'SENT' ? 'Already sent' : preparation?.status === 'FAILED' ? 'Draft needs attention' : preparation?.status === 'REJECTED' ? 'Previously rejected' : preparation?.deduped ? 'Already in review' : 'Draft prepared';
                return (
                  <article className="mailbox-message" aria-label={message.subject || '(no subject)'} key={message.id}>
                    <div className="mailbox-sender-avatar" aria-hidden="true">{(message.fromName || message.from || '?').slice(0, 1).toUpperCase()}</div>
                    <div className="mailbox-message-content">
                      <div className="mailbox-message-meta"><span className="mailbox-sender">{message.fromName || message.from || 'Unknown sender'}</span><time dateTime={message.receivedAt}>{formatDate(message.receivedAt)}</time></div>
                      {message.fromName && message.from && <div className="mailbox-sender-address">{message.from}</div>}
                      <h4>{message.subject || '(no subject)'}</h4>
                      <p className="mailbox-preview">{message.preview || 'No message preview available.'}</p>
                      <div className="mailbox-match-detail"><span className="mailbox-match-reason">{message.matchReason}</span>{message.orderNumbers.map((order) => <span className="mailbox-order" key={order}>Order {order}</span>)}{message.hasAttachments && <span className="mailbox-attachment">Has attachments</span>}</div>
                      {preparation?.error && <p className="mailbox-item-error" role="alert">{preparation.error}</p>}
                    </div>
                    <div className="mailbox-message-actions">
                      {preparation?.requestId ? (
                        <><span className={`mailbox-prepared ${preparation.status === 'FAILED' ? 'needs-attention' : ''}`}>{completedLabel}</span>{onOpenRequest && <button type="button" className="mailbox-secondary" disabled={busy} onClick={() => onOpenRequest(preparation.requestId!)}>{preparation.status === 'SENT' || preparation.status === 'FAILED' || preparation.status === 'REJECTED' ? 'View request' : 'Review draft'}<span aria-hidden="true">→</span></button>}</>
                      ) : <button type="button" className="mailbox-secondary" disabled={busy || !connected} onClick={() => void prepare([message.id])}>{isPreparing ? 'Preparing…' : preparation?.error ? 'Retry draft' : 'Prepare draft'}<span aria-hidden="true">→</span></button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="mailbox-footer"><span aria-hidden="true">✓</span>Drafts are reviewed before sending. Inbox search does not create or change SAP orders.</div>
    </section>
  );
}
