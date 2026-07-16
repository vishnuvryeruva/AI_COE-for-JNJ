import type { CsRequest, Stats } from '../types';

const BASE = import.meta.env.VITE_API_URL || '/api/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export const api = {
  health: () => request<{ status: string; aiCore: string }>('/health'),
  stats: () => request<Stats>('/stats'),

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
    request<CsRequest>(`/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }),

  reject: (id: string, reasonCode: string, comment?: string) =>
    request<CsRequest>(`/requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reasonCode, comment }),
    }),
};
