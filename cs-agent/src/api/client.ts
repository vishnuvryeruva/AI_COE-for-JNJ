import type { CsRequest, Stats } from '../types';

const BASE = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(detail.error || `Request failed: ${response.status}`, response.status, detail.code);
  }
  return response.json();
}

export interface AuthStatus {
  configured: boolean;
  signedIn: boolean;
  username: string | null;
}

export interface InboxMessage {
  id: string;
  internetMessageId: string | null;
  subject: string | null;
  from: string | null;
  fromName: string | null;
  receivedAt: string;
  preview: string;
  hasAttachments: boolean;
}

export interface MailboxMatch extends InboxMessage {
  matchReason: string;
  orderNumbers: string[];
}

export interface MailboxSearchResult {
  query: {
    label: string;
    terms: string[];
    orderNumber: string | null;
    since: string | null;
    before: string | null;
    sender: string | null;
  };
  messages: MailboxMatch[];
  scanned: number;
  limited: boolean;
  scope: string;
}

export const api = {
  health: () => request<{ status: string; aiCore: string }>('/health'),
  stats: () => request<Stats>('/stats'),

  authStatus: () => request<AuthStatus>('/auth/status'),
  authLoginUrl: `${BASE}/auth/login`,
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  listInbox: () => request<InboxMessage[]>('/mailbox/messages'),
  searchMailbox: (prompt: string, signal?: AbortSignal) =>
    request<MailboxSearchResult>('/mailbox/search', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
      signal,
    }),
  ingestInboxMessage: (id: string) =>
    request<{ request: CsRequest; deduped: boolean }>(`/mailbox/messages/${encodeURIComponent(id)}/ingest`, { method: 'POST' }),

  listRequests: (params: { status?: string } = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => Boolean(v)) as [string, string][]
    ).toString();
    return request<CsRequest[]>(`/requests${query ? `?${query}` : ''}`);
  },

  getRequest: (id: string) => request<CsRequest>(`/requests/${id}`),

  uploadEml: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ request: CsRequest; deduped: boolean }>('/requests/upload', {
      method: 'POST',
      body: form,
    });
  },

  ingestManual: (payload: { from: string; subject: string; body: string; mailingGroup?: string }) =>
    request<{ request: CsRequest }>('/requests/manual', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  loadScenarios: () =>
    request<{ created: number; requests: CsRequest[] }>('/requests/scenarios', { method: 'POST' }),

  saveDraft: (id: string, payload: { subject?: string; body?: string; to?: string; cc?: string[] }) =>
    request<CsRequest>(`/requests/${id}/draft`, { method: 'PATCH', body: JSON.stringify(payload) }),

  regenerate: (id: string) =>
    request<CsRequest>(`/requests/${id}/regenerate`, { method: 'POST', body: JSON.stringify({}) }),

  approve: (id: string) =>
    request<CsRequest & { sent?: boolean }>(`/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }),

  reject: (id: string, reasonCode: string, comment?: string) =>
    request<CsRequest>(`/requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reasonCode, comment }),
    }),
};
