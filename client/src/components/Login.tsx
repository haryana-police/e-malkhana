import { useState } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';

interface Props {
  onLogin: (user: User) => void;
}

interface Sample {
  id: string;
  password: string;
  name: string;
  rank: string;
  initials: string;
}

const SAMPLE_IDS: Sample[] = [
  { id: 'MM-001', password: 'rakesh', name: 'SI Rakesh Sharma',  rank: 'Sub-Inspector',      initials: 'RS' },
  { id: 'MM-002', password: 'vinod',  name: 'HC Vinod Kumar',    rank: 'Head Constable',     initials: 'VK' },
  { id: 'MM-003', password: 'sunita', name: 'ASI Sunita Devi',   rank: 'Asst Sub-Inspector', initials: 'SD' },
];

export function Login({ onLogin }: Props) {
  const [loginId, setLoginId]   = useState('MM-001');
  const [password, setPassword] = useState('rakesh');
  const [busy, setBusy]         = useState(false);
  const [busyId, setBusyId]     = useState<string | null>(null);
  const [msg, setMsg]           = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function pickSample(s: Sample) {
    setLoginId(s.id);
    setPassword(s.password);
    setMsg(null);
  }

  async function doLogin(id: string, pw: string, via: 'form' | 'quick') {
    setBusy(true);
    if (via === 'quick') setBusyId(id);
    setMsg(null);
    try {
      const r = await api.login(id, pw);
      setMsg({ kind: 'ok', text: `Welcome, ${r.user.name}.` });
      onLogin(r.user);
    } catch (e) {
      const err = e as ApiError;
      const detail = (err.body && err.body.error) || err.message;
      const suggestions: string[] = (err.body && Array.isArray(err.body.suggestions)) ? err.body.suggestions : [];
      setMsg({
        kind: 'error',
        text: `${detail}${suggestions.length ? ` — known IDs: ${suggestions.join(', ')}` : ''}`,
      });
    } finally {
      setBusy(false);
      setBusyId(null);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    doLogin(loginId.trim(), password, 'form');
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-emblem">HP</div>
        <div className="login-eyebrow">Haryana Police · Digital Records</div>
        <h1 className="login-title">e-Malkhana</h1>
        <div className="login-sub">Malkhana Moharrir (MM) sign-in</div>

        {/* =============== QUICK LOGIN =============== */}
        <div className="login-quick-header">⚡ Quick Login — one click</div>
        <div className="login-quick">
          {SAMPLE_IDS.map(s => (
            <button
              type="button"
              key={s.id}
              className="login-quick-btn"
              disabled={busy}
              onClick={() => doLogin(s.id, s.password, 'quick')}
            >
              <div className="login-quick-avatar">{s.initials}</div>
              <div className="login-quick-body">
                <div className="login-quick-id">{s.id}</div>
                <div className="login-quick-name">{s.name}</div>
                <div className="login-quick-rank">{s.rank}</div>
              </div>
              <div className="login-quick-arrow">
                {busyId === s.id ? '…' : '→'}
              </div>
            </button>
          ))}
        </div>

        <div className="login-divider">— or sign in manually —</div>

        {/* =============== MANUAL LOGIN =============== */}
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="full">
              MM Login ID
              <input
                value={loginId}
                onChange={e => setLoginId(e.target.value.toUpperCase())}
                placeholder="MM-001"
                autoFocus
                required
              />
            </label>
            <label className="full">
              Password
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••"
              />
            </label>
          </div>

          {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy || !loginId.trim()}>
              {busy ? 'Signing in…' : 'Sign in →'}
            </button>
          </div>
        </form>

        {/* =============== CREDENTIALS TABLE =============== */}
        <div className="login-creds-header">Sample login credentials (for reference)</div>
        <table className="login-creds">
          <thead>
            <tr><th>Login ID</th><th>Password</th><th>Officer</th><th></th></tr>
          </thead>
          <tbody>
            {SAMPLE_IDS.map(s => (
              <tr key={s.id}>
                <td><b>{s.id}</b></td>
                <td><code>{s.password}</code></td>
                <td>{s.name}</td>
                <td>
                  <button
                    type="button"
                    className="btn ghost xsmall"
                    onClick={() => pickSample(s)}
                    title="Fill the form with these credentials"
                  >fill</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="login-foot">
          PS Sector-5, Panchkula &nbsp;·&nbsp; {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
        </div>
      </div>
    </div>
  );
}
