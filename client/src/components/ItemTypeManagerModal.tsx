import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { RackItem, ItemType } from '../types';

interface Props {
  open: boolean;
  // The full set of sections (active + inactive) so the manager can
  // show a tab per section.  We mirror sections A–E and any the
  // admin added later — each gets its own independent item-type list.
  racks: RackItem[];
  onClose: () => void;
  onSaved?: (racks: RackItem[]) => void;
}

// One section's editable working state.  `draft` holds the live name of
// every row; `activeMap` holds the soft-delete flag; `order` is the
// current sort sequence (array of ids) so the up/down buttons reorder
// without a round-trip per click.
interface SectionState {
  byId: Record<number, ItemType>;
  order: number[];
  draft: Record<number, string>;
  activeMap: Record<number, boolean>;
}

function blankSection(): SectionState {
  return { byId: {}, order: [], draft: {}, activeMap: {} };
}

// Build a per-section map of working state from the server's ItemType[]
// rows.  Each section is independent — editing Part A's list never
// touches Part B's.
function buildStates(rows: ItemType[], racks: RackItem[]): Record<string, SectionState> {
  const out: Record<string, SectionState> = {};
  for (const r of racks) out[r.letter] = blankSection();
  for (const t of rows) {
    const letter = t.sectionLetter;
    if (!out[letter]) out[letter] = blankSection();
    out[letter].byId[t.id] = t;
    out[letter].order.push(t.id);
    out[letter].draft[t.id] = t.name;
    out[letter].activeMap[t.id] = t.active !== false;
  }
  // Keep each section's order sorted by server sortOrder (then name),
  // so the initial render matches the stored sequence.
  for (const k of Object.keys(out)) {
    out[k].order.sort((a, b) => {
      const xa = out[k].byId[a], xb = out[k].byId[b];
      return (xa.sortOrder || 0) - (xb.sortOrder || 0) || xa.name.localeCompare(xb.name);
    });
  }
  return out;
}

export function ItemTypeManagerModal({ open, racks, onClose, onSaved }: Props) {
  const activeRacks = racks.length ? racks : ([
    { letter: 'A', name: 'Narcotics Rack', count: 0, active: true },
    { letter: 'B', name: 'Weapons Almirah', count: 0, active: true },
    { letter: 'C', name: 'Documents & Cash', count: 0, active: true },
    { letter: 'D', name: 'Vehicles Yard', count: 0, active: true },
    { letter: 'E', name: 'Biological / Viscera', count: 0, active: true },
  ] as RackItem[]);

  const [states, setStates]   = useState<Record<string, SectionState>>({});
  const [tab, setTab]           = useState<string>('A');
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newName, setNewName]   = useState('');
  const [delTarget, setDelTarget] = useState<ItemType | null>(null);
  const [dirty, setDirty]       = useState<Record<string, boolean>>({});

  // Seed once when opened.
  useEffect(() => {
    if (!open) return;
    setMsg(null); setNewName(''); setDelTarget(null); setDirty({});
    api.itemTypes().then(rows => {
      const s = buildStates(rows, activeRacks);
      setStates(s);
      const first = activeRacks[0]?.letter || Object.keys(s)[0] || 'A';
      setTab(first);
    }).catch(e => setMsg({ kind: 'error', text: (e as Error).message }));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const sec = states[tab] || blankSection();
  const rackName = activeRacks.find(r => r.letter === tab)?.name || `Part ${tab}`;

  // Ordered list of item-types for the active tab.  MUST be declared BEFORE
  // the `if (!open) return null;` below — calling a hook after an early
  // return changes the hook order between open/closed renders and React
  // throws ("change in the order of Hooks called"), which crashed the modal
  // and left it blank when opened.
  const visible = useMemo(() => {
    return sec.order.map(id => sec.byId[id]).filter(Boolean);
  }, [sec]);

  if (!open) return null;

  function markDirty(letter: string) {
    setDirty(d => ({ ...d, [letter]: true }));
  }

  function setDraftName(id: number, name: string) {
    setStates(s => ({ ...s, [tab]: { ...s[tab], draft: { ...s[tab].draft, [id]: name } } }));
    markDirty(tab);
  }

  // ---- Reorder (up/down) ----
  function move(id: number, dir: -1 | 1) {
    setStates(s => {
      const cur = s[tab];
      const idx = cur.order.indexOf(id);
      const ni = idx + dir;
      if (idx < 0 || ni < 0 || ni >= cur.order.length) return s;
      const next = [...cur.order];
      [next[idx], next[ni]] = [next[ni], next[idx]];
      return { ...s, [tab]: { ...cur, order: next } };
    });
    markDirty(tab);
  }

  // ---- Soft delete / restore ----
  function toggleActive(id: number) {
    setStates(s => {
      const cur = s[tab];
      const next = !cur.activeMap[id];
      return { ...s, [tab]: { ...cur, activeMap: { ...cur.activeMap, [id]: next } } };
    });
    markDirty(tab);
  }

  // ---- Add ----
  async function addType() {
    const name = newName.trim();
    if (!name) { setMsg({ kind: 'error', text: 'Enter the new item type name.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const created = await api.createItemType(tab, name);
      setStates(s => {
        const cur = s[tab] || blankSection();
        return {
          ...s,
          [tab]: {
            ...cur,
            byId: { ...cur.byId, [created.id]: created },
            order: [...cur.order, created.id],
            draft: { ...cur.draft, [created.id]: created.name },
            activeMap: { ...cur.activeMap, [created.id]: true },
          },
        };
      });
      setNewName('');
      setMsg({ kind: 'ok', text: `Added "${created.name}" to Part ${tab}.` });
      setDirty(d => ({ ...d, [tab]: true }));
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // ---- Save (only dirty sections) ----
  async function save() {
    setBusy(true); setMsg(null);
    const letters = Object.keys(dirty).filter(l => dirty[l]);
    try {
      let changed = 0;
      for (const letter of letters) {
        const st = states[letter];
        if (!st) continue;
        // 1) name edits
        for (const id of st.order) {
          const t = st.byId[id];
          const name = (st.draft[id] ?? '').trim();
          if (name && name !== t.name) {
            await api.updateItemType(id, { name });
            st.byId[id] = { ...t, name };
            changed++;
          }
        }
        // 2) active toggles
        for (const id of st.order) {
          const t = st.byId[id];
          const next = st.activeMap[id] !== false;
          if (next !== (t.active !== false)) {
            await api.updateItemType(id, { active: next });
            st.byId[id] = { ...t, active: next };
            changed++;
          }
        }
        // 3) reorder — compute target sortOrder from the new sequence
        st.order.forEach((id, i) => {
          const t = st.byId[id];
          if ((t.sortOrder || 0) !== i * 10) {
            // fire-and-forget; the server persists sortOrder
            api.updateItemType(id, { sortOrder: i * 10 }).then(() => {
              st.byId[id] = { ...st.byId[id], sortOrder: i * 10 };
            }).catch(() => { /* surfaced on next reload */ });
          }
        });
      }
      if (changed === 0) {
        setMsg({ kind: 'ok', text: 'No changes to save.' });
      } else {
        setMsg({ kind: 'ok', text: `Saved ${changed} change(s) across ${letters.length} section(s).` });
      }
      setDirty({});
      setTimeout(() => { onClose(); setMsg(null); }, 700);
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
      await api.deleteItemType(delTarget.id);
      setStates(s => {
        const cur = s[delTarget.sectionLetter] || blankSection();
        const nextById = { ...cur.byId }; delete nextById[delTarget.id];
        const nextDraft = { ...cur.draft }; delete nextDraft[delTarget.id];
        const nextActive = { ...cur.activeMap }; delete nextActive[delTarget.id];
        return {
          ...s,
          [delTarget.sectionLetter]: {
            ...cur,
            byId: nextById,
            order: cur.order.filter(x => x !== delTarget.id),
            draft: nextDraft,
            activeMap: nextActive,
          },
        };
      });
      setDelTarget(null);
      setMsg({ kind: 'ok', text: `Removed "${delTarget.name}" from Part ${delTarget.sectionLetter}.` });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const totalTypes = Object.values(states).reduce((n, s) => n + s.order.length, 0);

  return (
    <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="form-card" style={{ maxWidth: 760, maxHeight: '92vh', overflow: 'auto' }}>
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        <h3>System Setting — Item Types</h3>
        <div className="sub">
          Each Malkhana section has its <b>own independent list</b> of item types. Pick a
          section above, then add, rename, reorder, or soft-delete types. Deleted
          types stay hidden from the “Register New Case Property” dropdown but their
          existing cases keep resolving to the saved name. Changes reflect in the
          dropdown immediately after you save.
        </div>

        {/* Section tabs — one per rack (A–E + any added) */}
        <div className="itemtype-tabs">
          {activeRacks.map(r => (
            <button
              key={r.letter}
              type="button"
              className={`itemtype-tab${tab === r.letter ? ' active' : ''}`}
              onClick={() => setTab(r.letter)}
              disabled={busy}
            >
              <span className="itemtype-tab-letter">{r.letter}</span>
              <span className="itemtype-tab-name">{r.name}</span>
            </button>
          ))}
        </div>

        <div className="itemtype-section-head">
          <b>Part {tab}</b> · {rackName}
          <span className="itemtype-count">{visible.length} type{visible.length === 1 ? '' : 's'}</span>
        </div>

        <div className="itemtype-list">
          {visible.length === 0 && (
            <div className="sub" style={{ padding: 16, textAlign: 'center' }}>
              No item types yet — add the first one below.
            </div>
          )}
          {visible.map((t, i) => {
            const inactive = sec.activeMap[t.id] === false;
            const deletable = (t.caseCount || 0) === 0;
            return (
              <div
                key={t.id}
                className="itemtype-row"
                style={inactive ? { opacity: 0.55, background: 'rgba(162,62,44,0.05)' } : undefined}
              >
                <div className="itemtype-row-name">
                  <input
                    value={sec.draft[t.id] ?? t.name}
                    onChange={e => setDraftName(t.id, e.target.value)}
                    placeholder={`item type for Part ${tab}`}
                    disabled={busy}
                  />
                  <span className="itemtype-case-badge" title={`${t.caseCount || 0} case(s) use this type`}>
                    {t.caseCount || 0} case{(t.caseCount || 0) === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="itemtype-row-actions">
                  <button
                    type="button" className="icon-btn" title="Move up"
                    onClick={() => move(t.id, -1)} disabled={busy || i === 0}
                  >↑</button>
                  <button
                    type="button" className="icon-btn" title="Move down"
                    onClick={() => move(t.id, 1)} disabled={busy || i === visible.length - 1}
                  >↓</button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={inactive ? 'Reactivate' : 'Soft-delete (hide from dropdown)'}
                    onClick={() => toggleActive(t.id)}
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
                    title={deletable ? `Delete "${t.name}"` : `Cannot delete — ${t.caseCount} case(s) use it`}
                    onClick={() => setDelTarget(t)}
                    disabled={busy || !deletable}
                    style={{
                      marginLeft: 6,
                      color: deletable ? 'var(--seal-red)' : 'var(--slate-soft)',
                      borderColor: deletable ? 'var(--seal-red)' : 'var(--line)',
                      cursor: deletable ? 'pointer' : 'not-allowed',
                    }}
                  >×</button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="itemtype-add">
          <div className="sub" style={{ margin: 0, flex: '0 0 auto', paddingRight: 8 }}>+ Add item type to Part {tab}</div>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="e.g. Smack, Pistol (.32), Stamp paper…"
            disabled={busy}
            onKeyDown={e => { if (e.key === 'Enter') addType(); }}
            style={{ flex: 1 }}
          />
          <button className="btn" type="button" onClick={addType} disabled={busy || !newName.trim()}>Add</button>
        </div>

        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save all'}</button>
        </div>

        {delTarget && (
          <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) setDelTarget(null); }}>
            <div className="form-card" style={{ maxWidth: 380 }}>
              <h3>Delete “{delTarget.name}”?</h3>
              <div className="sub" style={{ marginBottom: 16 }}>
                This item type will be removed from Part {delTarget.sectionLetter}'s list.
                {delTarget.caseCount > 0 && (
                  <div style={{ color: 'var(--seal-red)', marginTop: 6 }}>
                    {delTarget.caseCount} case(s) still use this type — reassign them first.
                  </div>
                )}
              </div>
              <div className="form-actions">
                <button className="btn ghost" onClick={() => setDelTarget(null)} disabled={busy}>Cancel</button>
                <button
                  className="btn"
                  onClick={confirmDelete}
                  disabled={busy || delTarget.caseCount > 0}
                  style={{ background: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}
                >
                  {busy ? 'Deleting…' : 'Delete type'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
