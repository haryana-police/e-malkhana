import type {
  DashboardData,
  CaseRow,
  AlertRow,
  MovementRow,
  MovementLogRow,
  AlertConfig,
  NewCaseInput,
  ScanInput,
  User,
  UploadResult,
  AuditEntry,
} from './types';

const base = '/api';

// The currently signed-in MM.  Set this from App.tsx on login/logout so that
// every write request automatically carries an X-MM-Id header for the audit
// log.  Defaults to "anonymous" when no one is signed in.
let currentMmId: string = 'anonymous';
export function setCurrentMm(id: string) { currentMmId = (id || 'anonymous').toUpperCase(); }
export function getCurrentMm() { return currentMmId; }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'X-MM-Id': currentMmId, 'X-MM-Name': currentMmId },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
    const detail = (parsed && parsed.error) || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
    throw new ApiError('GET', path, res.status, parsed, detail);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(method: string, path: string, status: number, body: any, detailOverride?: string) {
    const detail = detailOverride || (body && typeof body === 'object' && body.error)
      ? body.error
      : (typeof body === 'string' ? body : JSON.stringify(body));
    super(`API ${method} ${path} -> ${status}: ${detail}`);
    this.status = status;
    this.body = body;
    this.name = 'ApiError';
  }
}

async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-MM-Id': currentMmId, 'X-MM-Name': currentMmId },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: any = null;
    const text = await res.text().catch(() => '');
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    throw new ApiError(method, path, res.status, parsed);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // reads
  dashboard:   () => get<DashboardData>('/dashboard'),
  cases:       () => get<CaseRow[]>('/cases'),
  case:        (id: string) => get<CaseRow>(`/cases/${encodeURIComponent(id)}`),
  alerts:      () => get<AlertRow[]>('/alerts'),
  alertConfig: () => get<AlertConfig>('/alerts/config'),
  sections:    () => get<{ letter: string; name: string; count: number }[]>('/sections'),
  users:       () => get<User[]>('/users'),
  qr:          (id: string) => get<{ dataUrl: string; payload: string }>(`/cases/${encodeURIComponent(id)}/qr`),
  movements:   (id: string) => get<MovementLogRow[]>(`/cases/${encodeURIComponent(id)}/movements`),
  audit:       (params?: { limit?: number; userId?: string; action?: string; target?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit  != null) q.set('limit',  String(params.limit));
    if (params?.userId)         q.set('userId', params.userId);
    if (params?.action)         q.set('action', params.action);
    if (params?.target)         q.set('target', params.target);
    const qs = q.toString();
    return get<AuditEntry[]>(`/audit${qs ? '?' + qs : ''}`);
  },

  // writes
  login:         (loginId: string, password?: string) => send<{ user: User; station: string; asOf: string }>('POST', '/login', { loginId, password }),
  createCase:    (input: NewCaseInput)   => send<CaseRow>('POST',  '/cases', input),
  updateStatus:  (id: string, status: string) => send<CaseRow>('PATCH', `/cases/${encodeURIComponent(id)}/status`, { status }),
  renameSection: (letter: string, name: string) => send<{ letter: string; name: string; count: number }>('PATCH', `/sections/${encodeURIComponent(letter)}`, { name }),
  createSection: (name: string)                => send<{ letter: string; name: string; count: number }>('POST',  '/sections', { name }),
  deleteSection: (letter: string)               => send<{ letter: string; name: string; count: number; deleted: boolean }>('DELETE', `/sections/${encodeURIComponent(letter)}`, {}),
  updateAlerts:  (cfg: Partial<AlertConfig>) => send<AlertConfig>('PATCH', '/alerts/config', cfg),
  createMovement: (input: ScanInput) => send<{ case: CaseRow; movement?: MovementLogRow }>('POST', '/movements', input),
  scan:           (input: ScanInput) => send<{ case: CaseRow; movement?: MovementLogRow }>('POST', '/scan', input),
  upload:         (name: string, dataUrl: string) => send<UploadResult>('POST', '/upload', { name, dataUrl }),
};
