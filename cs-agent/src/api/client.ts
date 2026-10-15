import type { CsRequest, Stats } from '../types';

const BASE = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');
export const AUTH_INVALIDATED_EVENT = 'email-operations-auth-invalidated';

function invalidateAuth(reason: 'expired' | 'signedOut') {
  window.dispatchEvent(new CustomEvent(AUTH_INVALIDATED_EVENT, { detail: reason }));
}

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
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new ApiError('Could not reach the email service. Check your connection and try again.', 0);
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/status') invalidateAuth('expired');
    const detail = await response.json().catch(() => null);
    const fallback = response.status === 413
      ? 'This email is too large to upload. Choose a file smaller than 32 MB.'
      : response.status === 401
        ? 'Your session has expired. Sign in with your J&J account again to continue.'
        : response.status >= 500
          ? `The email service is unavailable (HTTP ${response.status}). Please try again. If this continues, ask your administrator to check the service.`
          : `The request could not be completed (HTTP ${response.status}). Please try again.`;
    throw new ApiError(typeof detail?.error === 'string' && detail.error.trim() ? detail.error : fallback, response.status, typeof detail?.code === 'string' ? detail.code : undefined);
  }
  return response.json().catch(() => {
    throw new ApiError('The email service returned an unreadable response. Please try again.', response.status);
  });
}

export interface AuthStatus {
  required: boolean;
  configured: boolean;
  signedIn: boolean;
  guest: boolean;
  guestEnabled: boolean;
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
  startGuest: () => request<{ ok: boolean }>('/auth/guest', { method: 'POST' }),
  logout: async () => {
    const result = await request<{ ok: boolean }>('/auth/logout', { method: 'POST' });
    invalidateAuth('signedOut');
    return result;
  },

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

  uploadEmail: (file: File) => {
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
