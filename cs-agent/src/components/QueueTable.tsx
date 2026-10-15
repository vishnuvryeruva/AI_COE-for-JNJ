import type { CsRequest } from '../types';
import { STATUS_LABEL, STATUS_TONE, confidenceTone, formatDate, pct, senderLabel } from '../lib/format';

interface Props {
  requests: CsRequest[];
  onOpen: (id: string) => void;
  filtered?: boolean;
  demoMode?: boolean;
}

export default function QueueTable({ requests, onOpen, filtered = false, demoMode = false }: Props) {
  if (requests.length === 0) {
    return (
      <div className="empty">
        <span className="empty-icon" aria-hidden="true">↳</span>
        <strong>{filtered ? 'No requests in this view' : demoMode ? 'Your demo work queue is ready' : 'Your next action starts in Outlook'}</strong>
        <p>{filtered ? 'Choose another status to see more requests.' : demoMode ? 'Load demo emails or import a saved email above to review your first draft.' : 'Find emails above, then prepare a draft to add a request to your queue.'}</p>
      </div>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Original sender</th>
          <th>Subject</th>
          <th>Intent</th>
          <th>Order</th>
          <th>Sender source</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {requests.map((request) => (
          <tr key={request.id} className="clickable" onClick={() => onOpen(request.id)}>
            <td>
              {request.email.from ? (
                <>
                  <div>{senderLabel(request.email.from, request.email.fromName)}</div>
                  <div style={{ fontSize: 12, color: 'var(--faint)' }}>{formatDate(request.receivedAt)}</div>
                </>
              ) : (
                <span className="chip err">Sender unknown</span>
              )}
            </td>
            <td>{request.email.subject || <span style={{ color: 'var(--faint)' }}>(no subject)</span>}</td>
            <td>
              {request.analysis.intentLabel ? (
                <span className="chip neutral">{request.analysis.intentLabel}</span>
              ) : (
                '—'
              )}
              {request.analysis.confidence !== null && (
                <div className="meter" style={{ width: 60 }}>
                  <span
                    data-tone={confidenceTone(request.analysis.confidence)}
                    style={{ width: `${(request.analysis.confidence ?? 0) * 100}%` }}
                  />
                </div>
              )}
            </td>
            <td className="mono">{request.analysis.orderNumber || '—'}</td>
            <td>
              <span className={`chip ${confidenceTone(request.extraction.confidence)}`}>
                {pct(request.extraction.confidence)}
              </span>
            </td>
            <td>
              <span className={`chip ${STATUS_TONE[request.status]}`}>{STATUS_LABEL[request.status]}</span>
            </td>
            <td>
              <button className="link-btn" onClick={(e) => { e.stopPropagation(); onOpen(request.id); }}>
                Review →
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
