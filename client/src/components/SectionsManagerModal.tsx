import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RackItem } from '../types';

interface Props {
  open: boolean;
  racks: RackItem[];          // active subset, used for the live count
  onClose: () => void;
  onSaved: (racks: RackItem[]) => void;
}

interface DeleteTarget {
  letter: string;
  name: string;
  count: number;
}

export function SectionsManagerModal({ open, racks, onClose, onSaved }: Props) {
  const [all, setAll]               = useState<RackItem[]>([]);  // includes deactivated
  const [draft, setDraft]           = useState<Record<string, string>>({});
  const [activeMap, setActiveMap]   = useState<Record<string, boolean>>({});
  const [busy, setBusy]             = useState(false);
  const [msg, setMsg]               = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newName, setNewName]       = useState('');
  const [delTarget, setDelTarget]   = useState<DeleteTarget | null>(null);
  const [filter, setFilter]         = useState<'all' | 'active' | 'inactive'>('all');

  // Load the FULL set (active + deactivated) when the modal opens — the
  // sidebar's `racks` prop only contains active sections, but the manager
  // must show the deactivated ones too so admins can re-activate them.
  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setNewName('');
    setDelTarget(null);
    setFilter('all');
    api.sections('all').then(rows => {
      setAll(rows);
      setDraft(Object.fromEntries(rows.map(r => [r.letter, r.name])));
      setActiveMap(Object.fromEntries(rows.map(r => [r.letter, r.active !== false])));
    }).catch(e => setMsg({ kind: 'error', text: (e as Error).message }));
  }, [open]);

  if (!open) return null;

  function set(letter: string, name: string) {
    setDraft(d => ({ ...d, [letter]: name }));
  }

  function reset() {
    setDraft(Object.fromEntries(all.map(r => [r.letter, r.name])));
    setActiveMap(Object.fromEntries(all.map(r => [r.letter, r.active !== false])));
    setMsg(null);
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      // 1) Renames (in parallel)
      const renameOps = all
        .map(r => ({ letter: r.letter, name: (draft[r.letter] ?? '').trim() }))
        .filter(x => x.name && x.name !== all.find(r => r.letter === x.letter)?.name);
      const renameResults = await Promise.all(renameOps.map(u => api.renameSection(u.letter, u.name)));

      // 2) Active toggles (in parallel; only the rows whose flag changed)
      const toggleOps = all.filter(r => {
        const next = activeMap[r.letter] !== false;
        return next !== (r.active !== false);
      });
      const toggleResults = await Promise.all(toggleOps.map(r =>
        api.setSectionActive(r.letter, activeMap[r.letter] !== false)
      ));

      if (renameOps.length === 0 && toggleOps.length === 0) {
        setMsg({ kind: 'ok', text: 'No changes to save.' });
        setBusy(false);
        return;
      }

      // Build the post-save view: re-merge into `all`, then derive the
      // active subset to push up to the parent (App) so the sidebar updates.
      const byLetter: Record<string, RackItem> = {};
      for (const r of renameResults) byLetter[r.letter] = r;
      for (const r of toggleResults) byLetter[r.letter] = r;
      const nextAll = all.map(r => byLetter[r.letter]
        ? { ...r, name: byLetter[r.letter].name, active: byLetter[r.letter].active, count: byLetter[r.letter].count }
        : r);
      setAll(nextAll);
      const activeOnly = nextAll.filter(r => r.active !== false);
      onSaved(activeOnly);
      const parts: string[] = [];
      if (renameOps.length)  parts.push(`renamed ${renameOps.length}`);
      if (toggleOps.length)  parts.push(`toggled ${toggleOps.length}`);
      setMsg({ kind: 'ok', text: `Saved (${parts.join(', ')}).` });
      setTimeout(onClose, 700);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function addSection() {
    const name = newName.trim();
    if (!name) {
      setMsg({ kind: 'error', text: 'Enter a name for the new section.' });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const created = await api.createSection(name);
      setAll(a => [...a, { ...created, active: true }].sort((a, b) =>
        a.letter.length - b.letter.length || a.letter.localeCompare(b.letter)
      ));
      setDraft(d => ({ ...d, [created.letter]: created.name }));
      setActiveMap(m => ({ ...m, [created.letter]: true }));
      setNewName('');
      setMsg({ kind: 'ok', text: `Added Part ${created.letter} · "${created.name}".` });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!delTarget) return;
    setBusy(true); setMsg(null);
    try {
      await api.deleteSection(delTarget.letter);
      setAll(a => a.filter(r => r.letter !== delTarget.letter));
      onSaved(all.filter(r => r.letter !== delTarget.letter && r.active !== false));
      setDelTarget(null);
      setMsg({ kind: 'ok', text: `Removed Part ${delTarget.letter} (${delTarget.name}).` });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // Filter the list to show according to the toolbar toggle.
  const visible = all.filter(r => {
    if (filter === 'active')   return activeMap[r.letter] !== false;
    if (filter === 'inactive') return activeMap[r.letter] === false;
    return true;
  });

  return (
    <div className={`overlay open`} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="form-card" style={{ maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}>
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        <h3>System Setting — Malkhana Sections</h3>
        <div className="sub">
          Edit section labels, add new racks, or <b>deactivate</b> sections that are
          out of use. Deactivated sections disappear from the "Register New
          Case Property" dropdown but their cases still resolve correctly to
          the name shown here. Deletion is only allowed for empty sections.
        </div>

        {/* Toolbar: status filter + counters */}
        <div className="sections-manager-toolbar">
          <div className="sub" style={{ margin: 0 }}>
            {all.length} total · {all.filter(r => activeMap[r.letter] !== false).length} active · {all.filter(r => activeMap[r.letter] === false).length} inactive
          </div>
          <div className="sections-manager-filter">
            {(['all', 'active', 'inactive'] as const).map(f => (
              <button
                key={f}
                type="button"
                className={`btn small ${filter === f ? '' : 'ghost'}`}
                onClick={() => setFilter(f)}
                disabled={busy}
              >{f[0].toUpperCase() + f.slice(1)}</button>
            ))}
          </div>
        </div>

        <div className="sections-manager-list">
          {visible.length === 0 && (
            <div className="sub" style={{ padding: 18, textAlign: 'center' }}>
              No sections match this filter.
            </div>
          )}
          {visible.map(r => {
            const inactive = activeMap[r.letter] === false;
            return (
              <div
                key={r.letter}
                className="sections-manager-row"
                style={inactive ? { opacity: 0.55, background: 'rgba(162,62,44,0.05)' } : undefined}
              >
                <div className="sections-manager-letter">{r.letter}</div>
                <input
                  value={draft[r.letter] ?? r.name}
                  onChange={e => set(r.letter, e.target.value)}
                  placeholder={`Part ${r.letter} label`}
                  disabled={busy}
                />
                <div className="sections-manager-count">{r.count} item{r.count === 1 ? '' : 's'}</div>
                <button
                  type="button"
                  className="icon-btn"
                  title={inactive ? 'Reactivate this section' : 'Deactivate (hide from new-case dropdown)'}
                  onClick={() => setActiveMap(m => ({ ...m, [r.letter]: inactive }))}
                  disabled={busy}
                  style={{
                    marginLeft: 6,
                    color: inactive ? 'var(--olive)' : 'var(--slate-soft)',
                    borderColor: inactive ? 'var(--olive)' : 'var(--line)',
                  }}
                >{inactive ? '⊕' : '⊖'}</button>
                <button
                  type="button"
                  className="icon-btn"
                  title={r.count > 0
                    ? `Cannot delete — ${r.count} case(s) in Part ${r.letter}`
                    : `Delete Part ${r.letter}`}
                  onClick={() => setDelTarget({ letter: r.letter, name: r.name, count: r.count })}
                  disabled={busy || r.count > 0}
                  style={{
                    marginLeft: 6, color: r.count > 0 ? 'var(--slate-soft)' : 'var(--seal-red)',
                    borderColor: r.count > 0 ? 'var(--line)' : 'var(--seal-red)',
                    cursor: r.count > 0 ? 'not-allowed' : 'pointer',
                  }}
                >×</button>
              </div>
            );
          })}
        </div>

        <div className="sections-manager-add">
          <div className="sub" style={{ margin: 0, flex: '0 0 auto', paddingRight: 8 }}>
            + Add new section
          </div>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="e.g. Digital Evidence, Explosives, …"
            disabled={busy}
            onKeyDown={e => { if (e.key === 'Enter') addSection(); }}
            style={{ flex: 1 }}
          />
          <button className="btn" type="button" onClick={addSection} disabled={busy || !newName.trim()}>
            Add
          </button>
        </div>

        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button className="btn ghost" onClick={reset} disabled={busy}>Reset</button>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save all'}</button>
        </div>
      </div>

      {/* Delete confirmation */}
      {delTarget && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) setDelTarget(null); }}>
          <div className="form-card" style={{ maxWidth: 380 }}>
            <h3>Delete Part {delTarget.letter}?</h3>
            <div className="sub" style={{ marginBottom: 16 }}>
              Section <b>"{delTarget.name}"</b> will be removed from the register.
              {delTarget.count > 0 && (
                <div style={{ color: 'var(--seal-red)', marginTop: 6 }}>
                  {delTarget.count} case(s) are still stored here — move or dispose them first.
                </div>
              )}
            </div>
            <div className="form-actions">
              <button className="btn ghost" onClick={() => setDelTarget(null)} disabled={busy}>Cancel</button>
              <button
                className="btn"
                onClick={confirmDelete}
                disabled={busy || delTarget.count > 0}
                style={{ background: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}
              >
                {busy ? 'Deleting…' : 'Delete section'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
