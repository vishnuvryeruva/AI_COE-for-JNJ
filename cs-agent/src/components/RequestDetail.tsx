import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CsRequest } from '../types';
import {
  EXTRACTION_LABEL, STATUS_LABEL, STATUS_TONE,
  confidenceTone, formatDate, formatTime, pct, senderLabel,
} from '../lib/format';

interface Props {
  id: string;
  outlookConnected: boolean;
  demoMode?: boolean;
  onBack: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

export default function RequestDetail({ id, outlookConnected, demoMode = false, onBack, onChanged, onError }: Props) {
  const [request, setRequest] = useState<CsRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);

  function load(data: CsRequest) {
    setRequest(data);
    setTo(data.draft.to || '');
    setSubject(data.draft.subject || '');
    setBody(data.draft.body || '');
    setDirty(false);
  }

  useEffect(() => {
    api.getRequest(id).then(load).catch((err) => onError(err.message));
  }, [id, onError]);

  async function act(fn: () => Promise<CsRequest>, back = false) {
    setBusy(true);
    try {
      const updated = await fn();
      load(updated);
      onChanged();
      if (back) onBack();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!request) return <div className="empty">Loading…</div>;

  const settled = request.status === 'SENT' || request.status === 'APPROVED' || request.status === 'REJECTED';
  const extractionFailed = !request.extraction.confidence;
  const canSend = Boolean(to.trim()) && !settled;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <button className="link-btn" onClick={onBack}>← Back to queue</button>
          <span className="spacer" />
          <span className="mono" style={{ color: 'var(--faint)' }}>{request.id.slice(0, 8)}</span>
          <span className={`chip ${STATUS_TONE[request.status]}`}>{STATUS_LABEL[request.status]}</span>
        </div>
        {request.statusReason && (
          <div className="panel-body" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{request.statusReason}</span>
          </div>
        )}
      </div>

      <div className="panes">
        {/* --- Pane 1: the email as received --- */}
        <div className="panel">
          <div className="panel-body">
            <h3 className="pane-title">1 · Original email</h3>

            {request.forwardedBy && (
              <div className="callout info">
                <strong>Forwarded by {request.forwardedBy}</strong>
                {request.csrNote && <div style={{ marginTop: 4, fontStyle: 'italic' }}>“{request.csrNote}”</div>}
              </div>
            )}

            <dl className="kv">
              <dt>From</dt>
              <dd>
                {request.email.from
                  ? senderLabel(request.email.from, request.email.fromName)
                  : <span className="chip err">Not identified</span>}
              </dd>
              <dt>To</dt>
              <dd className="mono">{request.email.to.join(', ') || '—'}</dd>
              <dt>Subject</dt>
              <dd>{request.email.subject || '(none)'}</dd>
              <dt>Sent</dt>
              <dd>{formatDate(request.email.sentAt)}</dd>
              <dt>Group</dt>
              <dd className="mono">{request.mailingGroup || '—'}</dd>
            </dl>

            <div className="email-body">{request.email.body || '(empty)'}</div>

            {request.email.attachments.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                Attachments: {request.email.attachments.map((a) => a.name).join(', ')}
              </div>
            )}
          </div>
        </div>

        {/* --- Pane 2: what the agent worked out --- */}
        <div className="panel">
          <div className="panel-body">
            <h3 className="pane-title">2 · Agent analysis</h3>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Sender extraction</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span className={`chip ${confidenceTone(request.extraction.confidence)}`}>
                  {pct(request.extraction.confidence)}
                </span>
                <span style={{ fontSize: 13 }}>
                  {EXTRACTION_LABEL[request.extraction.method || ''] || request.extraction.method}
                </span>
              </div>
            </div>

            {request.extraction.warnings.length > 0 && (
              <div className={`callout ${extractionFailed ? 'err' : 'warn'}`}>
                <strong>{extractionFailed ? 'Could not identify the sender' : 'Sender recovered by parsing'}</strong>
                <ul>
                  {request.extraction.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
                </ul>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Detected intent</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span className="chip info">{request.analysis.intentLabel || 'Unclassified'}</span>
                <span className={`chip ${confidenceTone(request.analysis.confidence)}`}>
                  {pct(request.analysis.confidence)}
                </span>
              </div>
              <div className="meter">
                <span
                  data-tone={confidenceTone(request.analysis.confidence)}
                  style={{ width: `${(request.analysis.confidence ?? 0) * 100}%` }}
                />
              </div>
            </div>

            {request.analysis.reasoning && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Reasoning</div>
                <div style={{ fontSize: 13 }}>{request.analysis.reasoning}</div>
              </div>
            )}

            <dl className="kv">
              <dt>Order no.</dt>
              <dd className="mono">{request.analysis.orderNumber || '—'}</dd>
              <dt>Delivery</dt>
              <dd className="mono">{request.analysis.deliveryNumber || '—'}</dd>
              <dt>Language</dt>
              <dd>{request.analysis.language || '—'}</dd>
              <dt>Requester</dt>
              <dd>{request.analysis.requesterType || '—'}</dd>
            </dl>

            <div className="callout info">
              <strong>POC 1 — no ERP data</strong>
              Order status, documents and attachments come in POC 2. The draft deliberately
              acknowledges the request rather than answering it.
            </div>
          </div>
        </div>

        {/* --- Pane 3: the draft --- */}
        <div className="panel">
          <div className="panel-body">
            <h3 className="pane-title">3 · Draft response</h3>

            {extractionFailed && (
              <div className="callout err">
                <strong>No recipient</strong>
                The original sender could not be identified, so there is nobody to reply to.
                Enter the address below, or reject this request.
              </div>
            )}

            <div className="field">
              <label htmlFor="to">To — the original sender</label>
              <input
                id="to"
                value={to}
                disabled={settled}
                placeholder="nobody identified — enter the customer address"
                onChange={(e) => { setTo(e.target.value); setDirty(true); }}
              />
            </div>

            <div className="field">
              <label>Cc — the mailing group</label>
              <input value={request.draft.cc.join(', ') || '—'} readOnly disabled />
            </div>

            <div className="field">
              <label htmlFor="subject">Subject</label>
              <input
                id="subject"
                value={subject}
                disabled={settled}
                onChange={(e) => { setSubject(e.target.value); setDirty(true); }}
              />
            </div>

            <div className="field">
              <label htmlFor="draft-body">Body</label>
              <textarea
                id="draft-body"
                value={body}
                disabled={settled}
                style={{ minHeight: 200 }}
                onChange={(e) => { setBody(e.target.value); setDirty(true); }}
              />
            </div>

            {!settled && (
              <div className="actions">
                <button
                  className="btn ok"
                  disabled={busy || !canSend}
                  title={canSend ? undefined : demoMode ? 'A recipient is required before approving the demo' : 'A recipient is required before sending'}
                  onClick={() =>
                    void act(async () => {
                      if (dirty) await api.saveDraft(request.id, { to, subject, body });
                      return api.approve(request.id);
                    }, true)
                  }
                >
                  {demoMode ? 'Approve demo' : outlookConnected ? 'Approve & send via Outlook' : 'Approve'}
                </button>
                <button
                  className="btn"
                  disabled={busy || !dirty}
                  onClick={() => void act(() => api.saveDraft(request.id, { to, subject, body }))}
                >
                  {dirty ? 'Save draft' : 'Saved'}
                </button>
                <button className="btn" disabled={busy} onClick={() => void act(() => api.regenerate(request.id))}>
                  Regenerate
                </button>
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => void act(() => api.reject(request.id, 'REJECTED_BY_REVIEWER'), true)}
                >
                  Reject
                </button>
              </div>
            )}

            {demoMode ? (
              <div className="callout info" style={{ marginTop: 14 }}>
                <strong>Demo approval</strong>
                Approve demo records your review decision. It does not send an email or connect to Outlook.
              </div>
            ) : outlookConnected ? (
              <div className="callout info" style={{ marginTop: 14 }}>
                <strong>Sends via Outlook</strong>
                Approve &amp; send delivers this reply through Microsoft Graph, from your own mailbox —
                To the sender, Cc the group. A copy lands in your Sent Items.
              </div>
            ) : (
              <div className="callout warn" style={{ marginTop: 14 }}>
                <strong>Sending is stubbed — not signed in to Outlook</strong>
                Approve records the decision and the audit entry but doesn't send. Connect Outlook on
                the main screen to send for real.
              </div>
            )}
          </div>
        </div>
      </div>

      {request.audit && request.audit.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Audit trail</h2></div>
          <div className="panel-body">
            <ul className="audit">
              {request.audit.map((event, i) => (
                <li key={i}>
                  <span className="ts">{formatTime(event.ts)}</span>
                  <span className="actor">{event.actor}</span>
                  <span><b>{event.action}</b>{event.details ? ` — ${event.details}` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
