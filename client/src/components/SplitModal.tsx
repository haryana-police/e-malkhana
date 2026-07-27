import { useEffect, useState } from 'react';

// ============================================================================
// SplitModal — Step 1 of the split flow (triggered from Case Property Detail).
//
// Flow:
//   • User clicks "⊟ Split Item" on the detail page.
//   • Modal asks "divide into how many splits?" (a number).
//   • That many rows open — each with just TWO fields: Title + Description.
//     (No quantity here — quantity is captured later on each split's movement
//     log, so the register stays flexible and honest.)
//
// On save we POST the array to /api/cases/:id/splits (bulk create).  Editing
// an existing split (title/description) and deleting a wrong split are handled
// in the detail page's split list, not here.
// ============================================================================

interface SplitDraft {
  title: string;
  description: string;
}

interface Props {
  caseId: string;
  onCancel: () => void;
  onSubmit: (drafts: SplitDraft[]) => Promise<void> | void;
  busy?: boolean;
}

const SAMPLE_TITLES = ['500g — sent for FSL', '500g — retained in Malkhana', 'Balance — sent to Police Line'];

export function SplitModal({ caseId, onCancel, onSubmit, busy = false }: Props) {
  const [count, setCount] = useState<number>(2);
  const [rows, setRows] = useState<SplitDraft[]>(makeRows(2));
  const [err, setErr] = useState<string | null>(null);

  // When the count changes, grow/shrink the row array without losing typed data.
  function applyCount(n: number) {
    const c = Math.max(1, Math.min(20, Math.floor(n) || 1));
    setCount(c);
    setRows(prev => {
      const next = [...prev];
      while (next.length < c) next.push({ title: '', description: '' });
      return next.slice(0, c);
    });
  }

  useEffect(() => { setRows(makeRows(2)); /* eslint-disable-next-line */ }, [caseId]);

  function setRow(i: number, key: keyof SplitDraft, val: string) {
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  }

  async function handleSave() {
    const cleaned = rows.map(r => ({ title: r.title.trim(), description: r.description.trim() }));
    if (!cleaned.some(r => r.title)) {
      setErr('Add at least one split title.');
      return;
    }
    setErr(null);
    await onSubmit(cleaned);
  }

  return (
    <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="form-card">
        <button type="button" className="tag-close" onClick={() => !busy && onCancel()} aria-label="Close">✕</button>
        <h3>Split Seized Item — {caseId}</h3>
        <div className="sub">
          One item stays as a single Malkhana entry (single MK no.). You are only
          branching its <b>movement ledger</b> into destinations.
        </div>

        <label className="full">
          Divide into how many splits?
          <input
            type="number" min={1} max={20} value={count}
            onChange={e => applyCount(parseInt(e.target.value, 10))}
            disabled={busy}
          />
        </label>

        <div className="split-rows">
          {rows.map((r, i) => (
            <div className="split-row" key={i}>
              <div className="split-row-head">
                <span className="split-idx">Split {i + 1}</span>
                <button type="button" className="btn ghost tiny"
                  title="Fill sample title"
                  onClick={() => setRow(i, 'title', SAMPLE_TITLES[i % SAMPLE_TITLES.length])}
                  disabled={busy}>↧ sample</button>
              </div>
              <label>
                Title
                <input
                  value={r.title}
                  onChange={e => setRow(i, 'title', e.target.value)}
                  placeholder="e.g. 500g send for FSL"
                  disabled={busy}
                />
              </label>
              <label>
                Description
                <textarea
                  value={r.description}
                  onChange={e => setRow(i, 'description', e.target.value)}
                  placeholder="any extra detail (optional)"
                  rows={2}
                  disabled={busy}
                />
              </label>
            </div>
          ))}
        </div>

        {err && <div className="form-msg show error" style={{ marginTop: 8 }}>{err}</div>}

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={handleSave} disabled={busy}>
            {busy ? 'Saving…' : `Create ${rows.length} split(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}

function makeRows(n: number): SplitDraft[] {
  return Array.from({ length: n }, () => ({ title: '', description: '' }));
}
