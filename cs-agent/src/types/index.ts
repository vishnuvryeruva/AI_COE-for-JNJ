export type Status = 'READY' | 'NEEDS_REVIEW' | 'FAILED' | 'SENT' | 'REJECTED';

export interface Attachment {
  name: string;
  mime: string;
  size: number;
}

export interface RequestEmail {
  from: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  body: string | null;
  sentAt: string | null;
  attachments: Attachment[];
}

export interface Extraction {
  method: 'RFC822_ATTACHMENT' | 'BODY_PARSE' | 'MANUAL' | 'GRAPH_DIRECT' | null;
  confidence: number | null;
  warnings: string[];
}

export interface Analysis {
  intent: string | null;
  intentLabel: string | null;
  confidence: number | null;
  reasoning: string | null;
  orderNumber: string | null;
  deliveryNumber: string | null;
  language: string | null;
  requesterType: string | null;
}

export interface Draft {
  to: string | null;
  cc: string[];
  subject: string | null;
  body: string | null;
}

export interface AuditEvent {
  ts: string;
  actor: string;
  action: string;
  details: string | null;
}

export interface CsRequest {
  id: string;
  status: Status;
  statusReason: string | null;
  source: string;
  receivedAt: string;
  forwardedBy: string | null;
  csrNote: string | null;
  mailingGroup: string | null;
  email: RequestEmail;
  extraction: Extraction;
  analysis: Analysis;
  draft: Draft;
  audit?: AuditEvent[];
}

export interface Stats {
  READY: number;
  NEEDS_REVIEW: number;
  FAILED: number;
  SENT: number;
  REJECTED: number;
  TOTAL: number;
}
