import { useEffect, useState } from 'react';
import { api, setCurrentMm } from './api';
import type {
  ViewName, CaseRow, CaseStatus, MovementEvent, AlertConfig, RackItem, User,
} from './types';
import { Letterhead } from './components/Letterhead';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { CaseProperty } from './components/CaseProperty';
import { Alerts } from './components/Alerts';
import { Movements } from './components/Movements';
import { TagModal } from './components/TagModal';
import { TimelineModal } from './components/TimelineModal';
import { RegisterCaseModal } from './components/RegisterCaseModal';
import { ScanModal } from './components/ScanModal';
import { SettingsModal } from './components/SettingsModal';
import { ChangeStatusModal } from './components/ChangeStatusModal';
import { Login } from './components/Login';
import { SectionsManagerModal } from './components/SectionsManagerModal';

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

export default function App() {
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
  }

  // -------- app state --------
  const [view, setView] = useState<ViewName>('dashboard');
  const [data, setData] = useState<BootData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [tagCase, setTagCase]     = useState<CaseRow | null>(null);
  const [tlFir, setTlFir]         = useState<string | null>(null);
  const [tlEvents, setTlEvents]   = useState<MovementEvent[]>([]);

  const [openRegister, setOpenRegister]         = useState(false);
  const [openScan, setOpenScan]                 = useState(false);
  const [openSettings, setOpenSettings]         = useState(false);
  const [openSectionsManager, setOpenSectionsManager] = useState(false);
  const [changeCase, setChangeCase]             = useState<CaseRow | null>(null);
  const [scanFlash, setScanFlash]               = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [activeStatus,  setActiveStatus]  = useState<CaseStatus | null>(null);
  // "Pending Disposal" tile semantics: show all cases except 'Disposed'.
  // Separate state from activeStatus because that one filters TO a single status.
  const [excludeDisposed, setExcludeDisposed] = useState<boolean>(false);

  async function reload() {
    try {
      const [dash, cases, alerts] = await Promise.all([
        api.dashboard(), api.cases(), api.alerts(),
      ]);
      setData({
        officer: dash.officer, racks: dash.racks, stats: dash.stats,
        recentMovements: dash.recentMovements, priorityAlerts: dash.priorityAlerts,
        cases, alerts,
      });
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { if (user) reload(); }, [user]);

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
    api.alerts().then(alerts => setData(d => d ? { ...d, alerts } : d));
  }

  function navWith(v: ViewName) {
    setView(v);
    setActiveSection(null);
    setActiveStatus(null);
    setExcludeDisposed(false);
  }

  function handleLogout() {
    setUser(null);
    setCurrentMm('anonymous');
    localStorage.removeItem(STORAGE_KEY);
    setView('dashboard');
    setActiveSection(null);
    setActiveStatus(null);
    setExcludeDisposed(false);
  }

  // Click on a dashboard stat-tile — navigates and pre-filters the case list
  // (or jumps to the alerts page for inspection-due).
  function onStatClick(target: 'all' | 'pending' | 'expert' | 'fsl' | 'inspection') {
    if (target === 'inspection') {
      setView('alerts');
      setActiveSection(null);
      setActiveStatus(null);
      setExcludeDisposed(false);
      return;
    }
    setView('caseproperty');
    setActiveSection(null);
    if      (target === 'all')     { setActiveStatus(null);   setExcludeDisposed(false); }
    else if (target === 'pending') { setActiveStatus(null);   setExcludeDisposed(true);  }  // all non-disposed
    else if (target === 'expert')  { setActiveStatus('Expert Opinion Pending'); setExcludeDisposed(false); }
    else if (target === 'fsl')     { setActiveStatus('With FSL'); setExcludeDisposed(false); }
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
      <Letterhead officer={data.officer} user={user} onLogout={handleLogout} />
      <div className="app">
        <Sidebar
          active={view}
          onNav={navWith}
          racks={data.racks}
          onRacksChange={onRacksChange}
          onOpenSettings={() => setOpenSettings(true)}
          onOpenSectionsManager={() => setOpenSectionsManager(true)}
          activeSection={activeSection}
          onSectionFilter={setActiveSection}
          user={user}
          onLogout={handleLogout}
        />
        <div className="main">
          {view === 'dashboard' && (
            <Dashboard
              stats={data.stats}
              movements={data.recentMovements}
              alerts={data.priorityAlerts}
              totalCases={data.cases.length}
              onStatClick={onStatClick}
              onOpenTag={setTagCase}
              onOpenTimeline={openTimeline}
              onOpenRegister={() => setOpenRegister(true)}
            />
          )}
          {view === 'caseproperty' && (
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
              onOpenRegister={() => setOpenRegister(true)}
              onChangeStatus={setChangeCase}
            />
          )}
          {view === 'movements' && (
            <Movements
              cases={data.cases}
              onOpenScan={() => setOpenScan(true)}
              onOpenChangeStatus={setChangeCase}
              onOpenTag={setTagCase}
            />
          )}
          {view === 'alerts' && (
            <Alerts alerts={data.alerts} onOpenSettings={() => setOpenSettings(true)} />
          )}
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
      <RegisterCaseModal
        open={openRegister}
        racks={data.racks}
        onClose={() => setOpenRegister(false)}
        onCreated={reload}
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
        onClose={() => setOpenSettings(false)}
        onUpdated={onAlertsUpdated}
        onOpenSectionsManager={() => { setOpenSettings(false); setOpenSectionsManager(true); }}
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
    </>
  );
}
