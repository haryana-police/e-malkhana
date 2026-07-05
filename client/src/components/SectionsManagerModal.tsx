import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RackItem } from '../types';

interface Props {
  open: boolean;
  racks: RackItem[];
  onClose: () => void;
  onSaved: (racks: RackItem[]) => void;
}

interface DeleteTarget {
  letter: string;
  name: string;
  count: number;
}

export function SectionsManagerModal({ open, racks, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [delTarget, setDelTarget] = useState<DeleteTarget | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(Object.fromEntries(racks.map(r => [r.letter, r.name])));
      setMsg(null);
      setNewName('');
      setDelTarget(null);
    }
  }, [open, racks]);

  if (!open) return null;

  function set(letter: string, name: string) {
    setDraft(d => ({ ...d, [letter]: name }));
  }

  function reset() {
    setDraft(Object.fromEntries(racks.map(r => [r.letter, r.name])));
    setMsg(null);
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      // Send renames in parallel for all letters whose name changed
      const updates = racks
        .map(r => ({ letter: r.letter, name: (draft[r.letter] ?? '').trim() }))
        .filter(x => x.name && x.name !== racks.find(r => r.letter === x.letter)?.name);
      if (updates.length === 0) {
        setMsg({ kind: 'ok', text: 'No changes to save.' });
        setBusy(false);
        return;
      }
      const results = await Promise.all(updates.map(u => api.renameSection(u.letter, u.name)));
      const byLetter: Record<string, { letter: string; name: string; count: number }> = {};
      for (const r of results) byLetter[r.letter] = r;
      onSaved(racks.map(r => byLetter[r.letter] ? { ...r, name: byLetter[r.letter].name, count: byLetter[r.letter].count } : r));
      setMsg({ kind: 'ok', text: `Saved ${updates.length} section name${updates.length === 1 ? '' : 's'}.` });
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
      onSaved([...racks, created].sort((a, b) =>
        a.letter.length - b.letter.length || a.letter.localeCompare(b.letter)
      ));
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
      onSaved(racks.filter(r => r.letter !== delTarget.letter));
      setDelTarget(null);
      setMsg({ kind: 'ok', text: `Removed Part ${delTarget.letter} (${delTarget.name}).` });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`overlay open`} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="form-card">
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        <h3>System Setting — Malkhana Sections</h3>
        <div className="sub">
          Edit section labels per station. Counts are computed automatically from
          the case register and cannot be edited here. Sections with cases cannot
          be deleted — move or dispose the cases first.
        </div>

        <div className="sections-manager-list">
          {racks.map(r => (
            <div key={r.letter} className="sections-manager-row">
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
          ))}
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
