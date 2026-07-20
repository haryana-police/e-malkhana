import { useEffect, useState } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import { api, setCurrentMm } from './api';
import type {
  ViewName, CaseRow, CaseStatus, MovementEvent, AlertConfig, RackItem, User,
  InspectionReport,
} from './types';
import { Letterhead } from './components/Letterhead';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { CaseProperty } from './components/CaseProperty';
import { Alerts } from './components/Alerts';
import { Movements } from './components/Movements';
import { Templates } from './components/Templates';
import { Inspection } from './components/Inspection';
import { TagModal } from './components/TagModal';
import { TimelineModal } from './components/TimelineModal';
import { RegisterCaseModal } from './components/RegisterCaseModal';
import { ScanModal } from './components/ScanModal';
import { SettingsModal } from './components/SettingsModal';
import { ChangeStatusModal } from './components/ChangeStatusModal';
import { Login } from './components/Login';
import { SectionsManagerModal } from './components/SectionsManagerModal';
import { ItemTypeManagerModal } from './components/ItemTypeManagerModal';
import { Footer } from './components/Footer';
import { CasePropertyDetail } from './components/CasePropertyDetail';

interface BootData {
  officer: { initials: string; name: string; rank: string };
  racks: RackItem[];
  stats: {
    totalProperty: number; pendingDisposal: number;
    expertPending: number; withFSL: number;
    inspectionDue: string; station: string; asOf: string;
  };
  recentMovements: { fir: string; item: string; movement: string; by: string; time: string }[];
  priorityAlerts: { level: 'urgent' | 'warn'; title: string; desc: string; days: string }[];
  cases: CaseRow[];
  alerts: { level: 'urgent' | 'warn'; title: string; desc: string; days: string }[];
}

const STORAGE_KEY = 'emalkhana_user_v1';

// Map ViewName <-> URL path.  Keeping this in one place means the sidebar
// and the router can't disagree about what "/alerts" is called.
function viewToPath(v: ViewName): string {
  switch (v) {
    case 'dashboard':    return '/dashboard';
    case 'caseproperty': return '/caseproperty';
    case 'movements':    return '/movements';
    case 'templates':    return '/templates';
    case 'alerts':       return '/alerts';
    case 'inspection':   return '/inspection';
  }
}
function pathToView(p: string): ViewName {
  if (p.startsWith('/caseproperty') || p.startsWith('/case-property')) return 'caseproperty';
  if (p.startsWith('/movements'))    return 'movements';
  if (p.startsWith('/templates'))    return 'templates';
  if (p.startsWith('/alerts'))       return 'alerts';
  if (p.startsWith('/inspection'))   return 'inspection';
  return 'dashboard';
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  // -------- auth state --------
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const u = JSON.parse(raw);
        setUser(u);
        setCurrentMm(u.id);
      }
    } catch { /* ignore */ }
    setAuthChecked(true);
  }, []);

  function handleLogin(u: User) {
    setUser(u);
    setCurrentMm(u.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    // Force the [user, reloadKey] effect to re-run even when `u` is the
    // same object reference as the previously stored user (logout → login
    // with the same MM, or page refresh that re-hydrates the same user).
    setReloadKey(k => k + 1);
  }

  // -------- app state --------
  // `view` is derived from the URL pathname so a deep link to
  // /caseproperty or /alerts lights up the right sidebar entry.
  const [view, setView] = useState<ViewName>(() => pathToView(location.pathname));
  useEffect(() => { setView(pathToView(location.pathname)); }, [location.pathname]);
  const [data, setData] = useState<BootData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [tagCase, setTagCase]     = useState<CaseRow | null>(null);
  const [tlFir, setTlFir]         = useState<string | null>(null);
  const [tlEvents, setTlEvents]   = useState<MovementEvent[]>([]);

  const [openScan, setOpenScan]                 = useState(false);
  const [openSettings, setOpenSettings]         = useState(false);
  const [settingsTab, setSettingsTab]           = useState<'thresholds' | 'fields' | 'backup' | 'log' | null>(null);
  const [settingsSingle, setSettingsSingle]     = useState(false);
  const [openSectionsManager, setOpenSectionsManager] = useState(false);
  const [openItemTypeManager, setOpenItemTypeManager] = useState(false);
  const [changeCase, setChangeCase]             = useState<CaseRow | null>(null);
  const [scanFlash, setScanFlash]               = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [activeStatus,  setActiveStatus]  = useState<CaseStatus | null>(null);
  // "Pending Disposal" tile semantics: show all cases except 'Disposed'.
  // Separate state from activeStatus because that one filters TO a single status.
  const [excludeDisposed, setExcludeDisposed] = useState<boolean>(false);

  // Mobile sidebar (drawer) — hidden by default on phones, toggled by hamburger
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Close drawer when viewport widens past the mobile breakpoint
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 981px)');
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setSidebarOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Close on Escape
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSidebarOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);
  // Lock body scroll while drawer is open
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  function navWith(v: ViewName) {
    setActiveSection(null);
    setActiveStatus(null);
    setExcludeDisposed(false);
    setSidebarOpen(false);  // close drawer on any nav click
    navigate(viewToPath(v));
  }

  // Click on the logo / title in the letterhead — go to the dashboard (home).
  function goHome() {
    navWith('dashboard');
  }

  // Reload = re-fetch dashboard/cases/alerts from the API and replace `data`
  // in one render.  Each call is wrapped in its own try/catch so a single
  // 500 (e.g. dashboard endpoint cold-starting slower than the others) does
  // NOT cause the whole reload to fail and fall through to the red
  // "Could not reach API" box.  The previous Promise.all() did exactly that:
  // dashboard.coldStart → reject → caught → err set → UI shows red screen
  // even though cases() and alerts() would have succeeded individually.
  async function reload() {
    const [dashR, casesR, alertsR, inspR] = [
      api.dashboard().catch(e => ({ __err: (e as Error).message })),
      api.cases().catch(e => ({ __err: (e as Error).message })),
      api.alerts().catch(e => ({ __err: (e as Error).message })),
      api.inspections().catch(e => ({ __err: (e as Error).message })),
    ];
    const [dash, cases, alerts, insp] = await Promise.all([dashR, casesR, alertsR, inspR]);
    const dashErr  = (dash  as any).__err as string | undefined;
    const casesErr = (cases as any).__err as string | undefined;
    const alErr    = (alerts as any).__err as string | undefined;
    if (casesErr) { setErr(casesErr); return; }
    const dashOk = !dashErr && dash ? (dash as any) : null;
    const casesOk = Array.isArray(cases) ? (cases as CaseRow[]) : null;
    const alOk = Array.isArray(alerts) ? (alerts as any) : null;
    const inspOk = Array.isArray(insp) ? (insp as InspectionReport[]) : null;
    // Merge non-compliant inspections into the Alerts & Compliance tab so a
    // failing inspection automatically surfaces there (Part 5).
    let mergedAlerts = alOk || [];
    if (inspOk) {
      const inspectionAlerts = inspOk
        .filter(i => i.overallStatus === 'Non-Compliant')
        .map(i => ({
          level: 'urgent',
          title: `Inspection ${i.inspectionId} — Non-Compliant (${i.policeStation})`,
          desc: `Inspecting officer: ${i.inspectingOfficerName} (${i.inspectingOfficerRank}), ${i.inspectionDate}. Malkhana compliance failed — corrective action required.`,
          days: i.inspectionDate,
          category: 'inspection',
          inspectionId: i.inspectionId,
        }));
      mergedAlerts = [...inspectionAlerts, ...mergedAlerts];
    }
    setData(d => {
      const next = d ? { ...d } : ({} as BootData);
      if (dashOk) {
        next.officer         = dashOk.officer;
        next.racks           = dashOk.racks;
        next.stats           = dashOk.stats;
        next.recentMovements = dashOk.recentMovements;
        next.priorityAlerts  = dashOk.priorityAlerts;
      }
      if (casesOk) next.cases = casesOk;
      if (alOk || inspOk) next.alerts = mergedAlerts;
      return next as BootData;
    });
    setErr(null);
  }
  // Run reload() on every (re)login.  Two trigger paths:
  //   1. `user` identity actually changes (different MM signs in)
  //   2. `reloadKey` bumps (same MM re-signs in after a logout).  Without
  //      (2), React's [user] dep sees the same object reference, the effect
  //      doesn't fire, and the visible list keeps showing yesterday's cases
  //      even though new writes have landed in Postgres.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => { if (user) reload(); }, [user, reloadKey]);

  async function openTimeline(fir: string) {
    setTlFir(fir); setTlEvents([]);
    try {
      const events = await api.movements(fir);
      setTlEvents(events.map(e => ({
        title: `${e.fromLocation === '—' ? 'New' : e.fromLocation} → ${e.toLocation}`,
        meta: `by ${e.movedBy} · ${new Date(e.timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })} · ${e.purpose}${e.docRef ? ' · ' + e.docRef : ''}`,
      })));
    } catch { setTlEvents([]); }
  }

  function onRacksChange(racks: RackItem[]) {
    setData(d => d ? { ...d, racks } : d);
  }

  function onAlertsUpdated(_cfg: AlertConfig) {
    // Re-fetch the dashboard stats so the new "Police Station name" and
    // any updated threshold (inspection-due text etc.) show immediately.
    api.dashboard().then(dash => {
      setData(d => d ? { ...d, stats: dash.stats } : d);
    }).catch(() => { /* keep prior stats on transient error */ });
    api.alerts().then(alerts => setData(d => d ? { ...d, alerts } : d));
  }

  function handleLogout() {
    setUser(null);
    setCurrentMm('anonymous');
    localStorage.removeItem(STORAGE_KEY);
    // Reset the in-memory snapshot so a re-login as the SAME user still
    // gets fresh data (the [user, reloadKey] effect would otherwise see the
    // same reference and skip the reload).
    setData(null);
    setActiveSection(null);
    setActiveStatus(null);
    setExcludeDisposed(false);
    navigate('/');
  }

  // Click on a dashboard stat-tile — navigates and pre-filters the case list
  // (or jumps to the alerts page for inspection-due).
  function onStatClick(target: 'all' | 'pending' | 'expert' | 'fsl' | 'transfer' | 'inspection') {
    if (target === 'inspection') {
      setActiveSection(null);
      setActiveStatus(null);
      setExcludeDisposed(false);
      navigate('/alerts');
      return;
    }
    navigate('/caseproperty');
    setActiveSection(null);
    if      (target === 'all')     { setActiveStatus(null);   setExcludeDisposed(false); }
    else if (target === 'pending') { setActiveStatus(null);   setExcludeDisposed(true);  }  // all non-disposed
    else if (target === 'expert')  { setActiveStatus('Expert Opinion Pending'); setExcludeDisposed(false); }
    else if (target === 'fsl')     { setActiveStatus('With FSL'); setExcludeDisposed(false); }
    else if (target === 'transfer'){ setActiveStatus('Transfer'); setExcludeDisposed(false); }
  }

  // Download handlers (used by Dashboard, CaseProperty, and Alerts).
  // Filter values are the EXACT ones on screen, so the file rows == the
  // visible rows.  For Dashboard / Alerts there's no filter, so we pass
  // the unfiltered URL.  For the Malkhana Register we respect the active
  // section filter from the sidebar.
  function buildReportFilters(ids?: string[]) {
    if (ids && ids.length) {
      // Export EXACTLY the rows currently visible on screen (respects
      // client-side search, column filters and newest-first sort).
      return { ids };
    }
    return {
      section: activeSection || 'all',
      status: activeStatus || (excludeDisposed ? 'all' : 'all'),
      excludeDisposed,
    };
  }
  function onDownloadReport(format: 'xlsx' | 'pdf', ids?: string[]) {
    const url = api.casePropertyReportUrl(buildReportFilters(ids), format);
    window.location.href = url;
  }
  function onGenerateRegister(format: 'pdf' | 'print') {
    if (format === 'pdf') {
      window.location.href = api.malkhanaRegisterUrl(activeSection || 'all');
    } else {
      // Browser print: open the API URL in a new window and let the
      // browser's print dialog render the PDF as a preview-able page.
      window.open(api.malkhanaRegisterUrl(activeSection || 'all'), '_blank');
    }
  }

  // -------- gate: not authed -> show login --------
  if (!authChecked) {
    return <div style={{ padding: 40, color: 'var(--slate-soft)' }}>Loading…</div>;
  }
  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  if (err) {
    return (
      <div style={{ padding: 40, color: 'var(--seal-red)' }}>
        <h2>Could not reach API</h2>
        <pre>{err}</pre>
      </div>
    );
  }
  if (!data) {
    return <div style={{ padding: 40, color: 'var(--slate-soft)' }}>Loading e-Malkhana…</div>;
  }

  return (
    <>
      <Letterhead
        officer={data.officer}
        user={user}
        onLogout={handleLogout}
        onMenuToggle={() => setSidebarOpen(o => !o)}
        menuOpen={sidebarOpen}
        onHome={goHome}
      />
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="app">
        <Sidebar
          active={view}
          onNav={navWith}
          racks={data.racks}
          onRacksChange={onRacksChange}
          onOpenSettings={(tab) => { if (tab) setSettingsTab(tab); setSettingsSingle(true); setOpenSettings(true); }}
          onOpenSettingsFull={() => { setSettingsSingle(false); setSettingsTab(null); setOpenSettings(true); }}
          onOpenSectionsManager={() => setOpenSectionsManager(true)}
          onOpenItemTypeManager={() => setOpenItemTypeManager(true)}
          activeSection={activeSection}
          onSectionFilter={setActiveSection}
          user={user}
          onLogout={handleLogout}
          mobileOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
        />
        <div className="main">
          <Routes>
            <Route path="/" element={
              <Dashboard
                stats={data.stats}
                movements={data.recentMovements}
                alerts={data.priorityAlerts}
                totalCases={data.cases.length}
                cases={data.cases}
                onStatClick={onStatClick}
                onOpenTag={setTagCase}
                onOpenTimeline={openTimeline}
                onOpenScan={() => setOpenScan(true)}
                onOpenRegister={() => navigate('/caseproperty/new')}
                onChangeStatus={setChangeCase}
                onDownloadReport={onDownloadReport}
                onViewAll={() => navigate('/caseproperty')}
              />
            } />
            <Route path="/dashboard" element={
              <Dashboard
                stats={data.stats}
                movements={data.recentMovements}
                alerts={data.priorityAlerts}
                totalCases={data.cases.length}
                cases={data.cases}
                onStatClick={onStatClick}
                onOpenTag={setTagCase}
                onOpenTimeline={openTimeline}
                onOpenScan={() => setOpenScan(true)}
                onOpenRegister={() => navigate('/caseproperty/new')}
                onChangeStatus={setChangeCase}
                onDownloadReport={onDownloadReport}
                onViewAll={() => navigate('/caseproperty')}
              />
            } />
            <Route path="/caseproperty" element={
              <CaseProperty
                cases={data.cases}
                activeSection={activeSection}
                onClearSection={() => setActiveSection(null)}
                activeStatus={activeStatus}
                onClearStatus={() => setActiveStatus(null)}
                excludeDisposed={excludeDisposed}
                onClearExcludeDisposed={() => setExcludeDisposed(false)}
                onOpenTag={setTagCase}
                onOpenTimeline={openTimeline}
                onOpenScan={() => setOpenScan(true)}
                onOpenRegister={() => navigate('/caseproperty/new')}
                onChangeStatus={setChangeCase}
                onDownloadReport={onDownloadReport}
              />
            } />
            <Route path="/caseproperty/new" element={
              <RegisterCaseModal
                open
                asPage
                racks={data.racks}
                user={user}
                onClose={() => navigate('/caseproperty')}
                onCreated={() => { reload(); navigate('/caseproperty'); }}
              />
            } />
            <Route path="/case-property/:item_id" element={
              <CasePropertyDetail />
            } />
            <Route path="/movements" element={
              <Movements
                cases={data.cases}
                active={view === 'movements'}
                onOpenScan={() => setOpenScan(true)}
                onOpenChangeStatus={setChangeCase}
                onOpenTag={setTagCase}
              />
            } />
            <Route path="/templates" element={<Templates />} />
            <Route path="/inspection" element={
              <Inspection
                user={user}
                onBack={navWith}
              />
            } />
            <Route path="/alerts" element={
              <Alerts
                alerts={data.alerts}
                onOpenSettings={(tab) => { if (tab) setSettingsTab(tab); setSettingsSingle(true); setOpenSettings(true); }}
              />
            } />
            <Route path="*" element={
              <Dashboard
                stats={data.stats}
                movements={data.recentMovements}
                alerts={data.priorityAlerts}
                totalCases={data.cases.length}
                cases={data.cases}
                onStatClick={onStatClick}
                onOpenTag={setTagCase}
                onOpenTimeline={openTimeline}
                onOpenScan={() => setOpenScan(true)}
                onOpenRegister={() => navigate('/caseproperty/new')}
                onChangeStatus={setChangeCase}
                onDownloadReport={onDownloadReport}
                onViewAll={() => navigate('/caseproperty')}
              />
            } />
          </Routes>
        </div>
      </div>

      <TagModal
        open={!!tagCase}
        data={tagCase}
        onClose={() => setTagCase(null)}
      />
      <TimelineModal
        open={!!tlFir}
        fir={tlFir}
        events={tlEvents}
        onClose={() => setTlFir(null)}
      />
      <ScanModal
        open={openScan}
        onClose={() => setOpenScan(false)}
        onSuccess={(c, recorded) => {
          setScanFlash({ kind: 'ok', text: recorded ? `Recorded movement for ${c.id}` : `Recognised ${c.id}` });
          setTimeout(() => setScanFlash(null), 3000);
          reload();
        }}
      />
      <SettingsModal
        open={openSettings}
        initialTab={settingsTab ?? undefined}
        single={settingsSingle}
        onClose={() => { setOpenSettings(false); setSettingsTab(null); setSettingsSingle(false); }}
        onUpdated={onAlertsUpdated}
        onOpenSectionsManager={() => { setOpenSettings(false); setOpenSectionsManager(true); }}
        onOpenItemTypeManager={() => { setOpenSettings(false); setOpenItemTypeManager(true); }}
      />
      <ChangeStatusModal
        open={!!changeCase}
        caseRow={changeCase}
        onClose={() => setChangeCase(null)}
        onChanged={() => {
          reload();
          setScanFlash({ kind: 'ok', text: 'Status updated · movement logged' });
          setTimeout(() => setScanFlash(null), 3000);
        }}
      />
      <SectionsManagerModal
        open={openSectionsManager}
        racks={data.racks}
        onClose={() => setOpenSectionsManager(false)}
        onSaved={(racks) => {
          onRacksChange(racks);
          setScanFlash({ kind: 'ok', text: 'Section names saved' });
          setTimeout(() => setScanFlash(null), 2500);
        }}
      />
      <ItemTypeManagerModal
        open={openItemTypeManager}
        racks={data.racks}
        onClose={() => setOpenItemTypeManager(false)}
        onSaved={() => {
          setScanFlash({ kind: 'ok', text: 'Item types saved' });
          setTimeout(() => setScanFlash(null), 2500);
          reload();
        }}
      />

      {scanFlash && (
        <div style={{
          position: 'fixed', bottom: 22, right: 22, zIndex: 200,
          background: scanFlash.kind === 'ok' ? 'var(--olive-bg)' : 'var(--seal-red-bg)',
          color: scanFlash.kind === 'ok' ? 'var(--olive)' : 'var(--seal-red)',
          border: '1px solid ' + (scanFlash.kind === 'ok' ? 'var(--olive)' : 'var(--seal-red)'),
          borderRadius: 6, padding: '10px 14px', fontSize: 12.5, fontWeight: 600,
          boxShadow: '0 6px 18px rgba(20,36,61,0.18)',
        }}>
          {scanFlash.text}
        </div>
      )}

      <Footer />
    </>
  );
}
