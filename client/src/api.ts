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
  BnsSection,
  ItemType,
  ItemTypeField,
  SectionMeta,
  FirMaster,
  CasePropertyData,
  InspectionReport,
  InspectionMeta,
  CategoryOfItem,
} from './types';

const base = '/api';

// The currently signed-in MM.  Set this from App.tsx on login/logout so that
// every write request automatically carries an X-MM-Id header for the audit
// log.  Defaults to "anonymous" when no one is signed in.
let currentMmId: string = 'anonymous';
export function setCurrentMm(id: string) { currentMmId = (id || 'anonymous').toUpperCase(); }
export function getCurrentMm() { return currentMmId; }

// Cold-start retry: a fresh Vercel function instance can take 1-3s to
// load the Postgres mirror (boot IIFE + Neon HTTP roundtrip).  During that
// window the audit middleware in server.js may throw "before boot()" and
// the API returns 500.  We retry GETs on that specific error a few times
// with a small backoff so the user sees the page load, not a flash of
// red text.  Writes are NOT retried — those should be idempotent on the
// server, not retried from the client (would risk double-PATCH / double-
// POST / double-DELETE).
function isColdStartError(status: number, body: any): boolean {
  if (status !== 500) return false;
  const msg = (body && body.error) || (typeof body === 'string' ? body : '');
  return typeof msg === 'string' && (
    msg.includes('before boot()') ||
    msg.includes('boot still in progress') ||
    msg.includes('cold start')
  );
}

async function get<T>(path: string): Promise<T> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      headers: { 'X-MM-Id': currentMmId, 'X-MM-Name': currentMmId },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (attempt < MAX_RETRIES - 1 && isColdStartError(res.status, parsed)) {
        // 1.2s, 2.4s, 4.8s — small backoff so the boot can finish.
        await new Promise(r => setTimeout(r, 1200 * Math.pow(2, attempt)));
        continue;
      }
      const detail = (parsed && parsed.error) || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
      throw new ApiError('GET', path, res.status, parsed, detail);
    }
    return res.json() as Promise<T>;
  }
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
  itemTypes:   (section?: string) => get<ItemType[]>(`/item-types${section ? `?section=${encodeURIComponent(section)}` : ''}`),

  // ---- Category of Item master (DB-backed, admin-editable) ----
  itemCategories: () => get<CategoryOfItem[]>('/item-categories'),
  upsertItemCategory: (cat: Partial<CategoryOfItem> & { id: string; label?: string }) =>
    send<CategoryOfItem>(cat.id ? 'PATCH' : 'POST', `/item-categories${cat.id ? `/${encodeURIComponent(cat.id)}` : ''}`, cat),
  deleteItemCategory: (id: string) =>
    send<{ id: string; deleted: boolean }>('DELETE', `/item-categories/${encodeURIComponent(id)}`, {}),
  // ---- Item Type Fields (legacy per-section popup builder) ----
  itemTypeFields: (section: string) => get<ItemTypeField[]>(`/item-type-fields?section=${encodeURIComponent(section)}`),
  upsertItemTypeField: (section: string, f: Partial<ItemTypeField> & { label: string }) =>
    send<ItemTypeField>('POST', '/item-type-fields', { section, ...f }),
  deleteItemTypeField: (id: number) =>
    send<{ id: number; deleted: boolean }>('DELETE', `/item-type-fields/${id}`, {}),
  firMaster: (firNo: string) => get<FirMaster>(`/fir-master/${encodeURIComponent(firNo)}`),
  // Live substring search across FIR/DD numbers for the Register form
  // typeahead (single-select lookup-as-you-type). Returns candidates with
  // record type, police station and item count.
  searchFirMaster: (q: string, limit: number = 8) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    p.set('limit', String(limit));
    return get<FirMaster[]>(`/fir-master/search?${p.toString()}`);
  },
  upsertFirMaster: (fir: Partial<FirMaster> & { firNo: string }) =>
    send<FirMaster>('POST', '/fir-master', fir),
  caseProperty: (itemId: string) => get<CasePropertyData>(`/case-property/${encodeURIComponent(itemId)}`),
  saveCaseProperty: (payload: { itemId: string; firNo?: string; common: Record<string, string>; fields: { key: string; value: string }[] }) =>
    send<CasePropertyData>('POST', '/case-property', payload),
  // Multi-item registration under one FIR/DD.  See server.js POST /api/cases/batch.
  createCaseBatch: (payload: {
    firOrDd: string; firNo?: string; recordType?: 'FIR' | 'DD';
    policeStation?: string; firDate?: string | null; usSections?: string | null; io?: string | null;
    ddDate?: string | null; natureOfDd?: string | null; nameOfDeceased?: string | null; reportingPerson?: string | null;
    actualSeizureDdNo?: string | null; actualSeizureDate?: string | null;
    common: Record<string, any>;
    items: Array<{
      itemType: string; sectionLetter: string; itemTypeId?: number | null; description?: string;
      category?: string; subType?: string; malkhanaSection?: string; legalSections?: string[];
      seizingOfficer?: string; photo?: string; status?: string;
      quantity?: string; placeOfSeizure?: string; physicalStorage?: string; remarks?: string;
      sealSealed?: string; sealNo?: string; sealBy?: string;
      popupFields: { key: string; value: string }[];
    }>;
  }) => send<{ firNo: string; items: { itemId: string; itemType: string; section: string }[] }>('POST', '/cases/batch', payload),
  sections:    (active: 'true' | 'false' | 'all' = 'true') =>
    get<{ letter: string; name: string; count: number; active?: boolean }[]>(`/sections?active=${active}`),
  // manager CRUD (auth as the signed-in MM, like the sections API)
  createItemType:  (sectionLetter: string, name: string, sortOrder?: number) =>
    send<ItemType>('POST', '/item-types', { sectionLetter, name, ...(sortOrder != null ? { sortOrder } : {}) }),
  updateItemType:  (id: number, patch: Partial<{ name: string; sortOrder: number; active: boolean }>) =>
    send<ItemType>('PATCH', `/item-types/${id}`, patch),
  deleteItemType:  (id: number) =>
    send<{ id: number; sectionLetter: string; name: string; deleted: boolean }>('DELETE', `/item-types/${id}`, {}),
  // BNS (Bharatiya Nyaya Sanhita) section typeahead.  `q` is the live
  // search text from the Register form.  Empty `q` returns the first 15
  // (so the dropdown has content the moment the field is focused).
  bnsSections: (q: string = '', limit: number = 15) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    p.set('limit', String(limit));
    return get<BnsSection[]>(`/bns-sections?${p.toString()}`);
  },
  users:       () => get<User[]>('/users'),
  qr:          (id: string) => get<{ dataUrl: string; payload: string; encrypted?: boolean; mask?: string }>(`/cases/${encodeURIComponent(id)}/qr`),
  movements:   (id: string) => get<MovementLogRow[]>(`/cases/${encodeURIComponent(id)}/movements`),
  // System Settings manages the persisted movement-log rows directly.
  // The list is sorted newest-first; the same caseId, fromLocation,
  // toLocation, movedBy, purpose, docRef, and timestamp fields apply
  // that the case-detail timeline already shows.
  movementLogs: () => get<MovementLogRow[]>('/movement-logs'),
  createMovementLog: (row: { caseId: string; fromLocation?: string; toLocation: string; movedBy: string; timestamp?: string; purpose?: string; docRef?: string }) =>
    send<MovementLogRow>('POST', '/movement-logs', row),
  updateMovementLog: (id: number, patch: { caseId?: string; fromLocation?: string; toLocation?: string; movedBy?: string; timestamp?: string; purpose?: string; docRef?: string }) =>
    send<MovementLogRow>('PATCH', `/movement-logs/${id}`, patch),
  deleteMovementLog: (id: number) =>
    send<{ id: number; deleted: boolean }>('DELETE', `/movement-logs/${id}`, {}),
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

  // Edit editable fields of an existing case from the Case Property Detail
  // page (itemType, itemSub, section, seizingOfficer, itemId,
  // legalSection).  Only present keys are sent to the server, so a partial
  // update is fine.  Returns the updated CaseRow (with fresh sectionName
  // joined server-side).
  updateCase:    (id: string, patch: Partial<{
    itemType: string; itemSub: string; section: string;
    seizingOfficer: string; itemId: string;
    legalSection: string | null;
  }>) => send<CaseRow>('PATCH', `/cases/${encodeURIComponent(id)}`, patch),

  // downloads — the browser does the navigation; we just return the URL.
  // Filters match the API exactly so the rows on screen == the rows in
  // the file.
  casePropertyReportUrl: (filters: {
    section?: string; status?: string | null; excludeDisposed?: boolean;
    from?: string; to?: string; q?: string; ids?: string[];
  }, format: 'xlsx' | 'pdf') => {
    const p = new URLSearchParams();
    p.set('format', format);
    if (filters.ids && filters.ids.length) {
      p.set('ids', filters.ids.join(','));
    } else {
      if (filters.section && filters.section !== 'all') p.set('section', filters.section);
      if (filters.status  && filters.status  !== 'all') p.set('status',  filters.status);
      if (filters.excludeDisposed) p.set('excludeDisposed', '1');
      if (filters.from) p.set('from', filters.from);
      if (filters.to)   p.set('to',   filters.to);
      if (filters.q)    p.set('q',    filters.q);
    }
    return `${base}/reports/case-property?${p.toString()}`;
  },
  malkhanaRegisterUrl: (section: string = 'all') =>
    `${base}/reports/malkhana-register?section=${encodeURIComponent(section)}&format=pdf`,

  // backups (admin)
  backupStatus: () => get<{
    cron: string; retentionDays: number; scriptPath: string;
    last: any; lastSuccess: any; lastFailed: any; totalRuns: number; summary: string;
  }>('/backups/status'),
  backupLog:    (limit = 20) => get<any[]>(`/backups/log?limit=${limit}`),
  backupRun:    () => send<{ ok: boolean; code?: number; fileName?: string; error?: string }>('POST', '/backups/run', {}),

  // other
  renameSection: (letter: string, name: string) => send<{ letter: string; name: string; count: number; active?: boolean }>('PATCH', `/sections/${encodeURIComponent(letter)}`, { name }),
  setSectionActive: (letter: string, active: boolean) => send<{ letter: string; name: string; count: number; active?: boolean }>('PATCH', `/sections/${encodeURIComponent(letter)}/active`, { active }),
  createSection: (name: string)                => send<{ letter: string; name: string; count: number; active?: boolean }>('POST',  '/sections', { name }),
  deleteSection: (letter: string)               => send<{ letter: string; name: string; count: number; deleted: boolean }>('DELETE', `/sections/${encodeURIComponent(letter)}`, {}),
  reorderSections: (order: string[])            => send<{ letter: string; name: string; count: number; active?: boolean; sortOrder?: number }[]>('PATCH', '/sections/order', { order }),
  updateAlerts:  (cfg: Partial<AlertConfig>) => send<AlertConfig>('PATCH', '/alerts/config', cfg),
  createMovement: (input: ScanInput) => send<{ case: CaseRow; movement?: MovementLogRow }>('POST', '/movements', input),
  scan:           (input: ScanInput) => send<{ case: CaseRow; movement?: MovementLogRow }>('POST', '/scan', input),
  // ---- Inspection register ----
  inspections:        () => get<InspectionReport[]>('/inspections'),
  inspection:         (id: string) => get<InspectionReport>(`/inspections/${encodeURIComponent(id)}`),
  inspectionMeta:     () => get<InspectionMeta>('/inspections/meta/next-id'),
  saveInspection:     (rec: Partial<InspectionReport> & { status: string; report: any }) =>
    send<InspectionReport>('POST', '/inspections', rec),
  updateInspection:   (rec: Partial<InspectionReport> & { inspectionId: string; status: string; report: any }) =>
    send<InspectionReport>('PATCH', '/inspections', rec),
  deleteInspection:   (id: string) => send<{ id: string; deleted: boolean }>('DELETE', `/inspections/${encodeURIComponent(id)}`, {}),

  upload:         (name: string, dataUrl: string) => send<UploadResult>('POST', '/upload', { name, dataUrl }),
};
