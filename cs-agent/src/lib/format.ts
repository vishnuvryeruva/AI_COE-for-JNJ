import type { Status } from '../types';

export const STATUS_LABEL: Record<Status, string> = {
  READY: 'Ready',
  NEEDS_REVIEW: 'Needs review',
  FAILED: 'Failed',
  SENT: 'Sent',
  APPROVED: 'Approved (demo)',
  REJECTED: 'Rejected',
};

export const STATUS_TONE: Record<Status, string> = {
  READY: 'ok',
  NEEDS_REVIEW: 'warn',
  FAILED: 'err',
  SENT: 'info',
  APPROVED: 'info',
  REJECTED: 'neutral',
};

export const EXTRACTION_LABEL: Record<string, string> = {
  MSG_DIRECT: 'Saved Outlook message',
  EML_DIRECT: 'Saved email headers',
  MSG_ATTACHMENT: 'Forwarded Outlook attachment',
  RFC822_ATTACHMENT: 'Forwarded as attachment',
  BODY_PARSE: 'Parsed from message body',
  MANUAL: 'Entered manually',
  GRAPH_DIRECT: 'Outlook message headers',
};

export function confidenceTone(value: number | null): string {
  if (value === null || value === undefined) return 'err';
  if (value >= 0.75) return 'ok';
  if (value > 0) return 'warn';
  return 'err';
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function senderLabel(from: string | null, fromName: string | null): string {
  if (fromName && from) return `${fromName} <${from}>`;
  return from || fromName || 'Unknown sender';
}
