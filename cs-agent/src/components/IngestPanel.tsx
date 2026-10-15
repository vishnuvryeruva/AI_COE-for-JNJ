import { useRef, useState } from 'react';
import { api } from '../api/client';

interface Props {
  demoMode?: boolean;
  onIngested: () => void;
  onError: (message: string) => void;
}

export default function IngestPanel({ demoMode = false, onIngested, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const processing = useRef(false);

  async function run(fn: () => Promise<unknown>) {
    if (processing.current) return;
    processing.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      onIngested();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      processing.current = false;
      setBusy(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (processing.current || !files.length) return;
    setNotice(null);
    if (files.some((file) => !/\.(eml|msg)$/i.test(file.name))) {
      onError('Choose a saved Outlook .msg or .eml email. Other file types are not supported.');
      return;
    }
    if (files.some((file) => file.size > 32 * 1024 * 1024)) {
      onError('Each email must be 32 MB or smaller. Choose a smaller .msg or .eml file.');
      return;
    }
    processing.current = true;
    setBusy(true);
    let imported = 0;
    try {
      for (const file of files) {
        await api.uploadEmail(file);
        imported += 1;
      }
      setNotice(`${imported} ${imported === 1 ? 'email imported' : 'emails imported'}. Review your work queue.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`${imported ? `${imported} ${imported === 1 ? 'email was' : 'emails were'} imported before this error. ` : ''}${message}`);
    } finally {
      if (imported) onIngested();
      processing.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{demoMode ? 'Start a demo request' : 'Manual import'}</h2>
        <span className="sub">{demoMode ? 'Load sample emails or try your own saved email' : 'Use a saved email or enter its contents'}</span>
        <span className="spacer" />
        <button className={`btn ${demoMode ? 'primary' : 'sm'}`} disabled={busy} onClick={() => run(api.loadScenarios)}>
          {demoMode ? 'Load demo emails' : 'Load scenario emails'}
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
            void uploadFiles(Array.from(e.dataTransfer.files));
          }}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click(); } }}
          role="button"
          aria-disabled={busy}
          aria-label="Upload Outlook .msg or .eml emails"
          tabIndex={0}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".eml,.msg,message/rfc822,application/vnd.ms-outlook"
            disabled={busy}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files || []);
              e.currentTarget.value = '';
              void uploadFiles(files);
            }}
          />
          <strong>{busy ? 'Processing email…' : 'Drop an Outlook .msg or .eml email here'}</strong>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Save an email from Outlook as .msg or .eml, then drop the saved file here or click to choose it. Up to 32 MB per email.
          </div>
        </div>
        {notice && <p role="status">{notice}</p>}

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
