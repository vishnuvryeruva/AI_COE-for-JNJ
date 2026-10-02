import { useRef, useState } from 'react';
import { api } from '../api/client';

interface Props {
  onIngested: () => void;
  onError: (message: string) => void;
}

export default function IngestPanel({ onIngested, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onIngested();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (busy || !files?.length) return;
    if (Array.from(files).some((file) => !file.name.toLowerCase().endsWith('.eml'))) {
      onError('Choose a saved .eml email. Outlook .msg files are not supported.');
      return;
    }
    await run(async () => {
      for (const file of Array.from(files)) {
        await api.uploadEml(file);
      }
    });
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Manual import</h2>
        <span className="sub">Use a saved email or enter its contents</span>
        <span className="spacer" />
        <button className="btn sm" disabled={busy} onClick={() => run(api.loadScenarios)}>
          Load scenario emails
        </button>
      </div>

      <div className="panel-body">
        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void uploadFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click(); } }}
          role="button"
          tabIndex={0}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".eml,message/rfc822"
            multiple
            hidden
            onChange={(e) => void uploadFiles(e.target.files)}
          />
          <strong>Drop a forwarded .eml here</strong>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            In Outlook use <b>Forward as Attachment</b> (Ctrl+Alt+F), then save the message as .eml.
            A plain forward also works, but the sender is recovered by parsing and gets flagged for review.
          </div>
        </div>

        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
            Or enter an email manually
          </summary>
          <div style={{ marginTop: 12 }}>
            <div className="row">
              <div className="field">
                <label htmlFor="manual-from">From</label>
                <input
                  id="manual-from"
                  value={from}
                  placeholder="John Smith &lt;john.smith@acmecorp.com&gt;"
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="manual-subject">Subject</label>
                <input
                  id="manual-subject"
                  value={subject}
                  placeholder="Please send Packing List"
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="manual-body">Body</label>
              <textarea
                id="manual-body"
                value={body}
                placeholder="Can you please send packing list for order 5003000237."
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <button
              className="btn primary"
              disabled={busy || !from.trim() || !body.trim()}
              onClick={() =>
                void run(async () => {
                  await api.ingestManual({ from, subject, body });
                  setFrom('');
                  setSubject('');
                  setBody('');
                })
              }
            >
              {busy ? 'Processing…' : 'Process email'}
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}
