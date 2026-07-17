import { useCallback, useEffect, useState } from 'react';
import { api, type AuthStatus, type InboxMessage } from '../api/client';
import { formatDate } from '../lib/format';

interface Props {
  auth: AuthStatus;
  onAuthChange: () => void;
  onIngested: () => void;
  onError: (message: string) => void;
}

export default function MailboxPanel({ auth, onAuthChange, onIngested, onError }: Props) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      setMessages(await api.listInbox());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    if (auth.signedIn) void loadInbox();
  }, [auth.signedIn, loadInbox]);

  // Not signed in yet — show the connect button.
  if (!auth.signedIn) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Outlook</h2>
          <span className="sub">Connect your mailbox to pick emails directly</span>
        </div>
        <div className="panel-body" style={{ textAlign: 'center', padding: 28 }}>
          <a className="btn primary" href="/api/v1/auth/login">
            Sign in with Microsoft
          </a>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
            You'll sign in with your organisation account. The app then shows your inbox — pick an
            email to process, review the draft, and send the reply as yourself.
          </div>
        </div>
      </div>
    );
  }

  async function process(id: string) {
    setBusyId(id);
    try {
      await api.ingestInboxMessage(id);
      onIngested();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function signOut() {
    try {
      await api.logout();
      onAuthChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Outlook inbox</h2>
        <span className="sub">{auth.username}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={loading} onClick={() => void loadInbox()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button className="btn sm" onClick={() => void signOut()}>Sign out</button>
      </div>

      {messages.length === 0 ? (
        <div className="empty">{loading ? 'Loading inbox…' : 'Inbox is empty.'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>Subject</th>
              <th>Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.id}>
                <td>
                  <div>{message.fromName || message.from || 'Unknown'}</div>
                  <div style={{ fontSize: 12, color: 'var(--faint)' }}>{message.from}</div>
                </td>
                <td>
                  <div>{message.subject || '(no subject)'}</div>
                  <div style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {message.preview?.slice(0, 80)}
                    {message.hasAttachments ? ' 📎' : ''}
                  </div>
                </td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDate(message.receivedAt)}</td>
                <td>
                  <button
                    className="btn primary sm"
                    disabled={busyId === message.id}
                    onClick={() => void process(message.id)}
                  >
                    {busyId === message.id ? 'Processing…' : 'Process'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
