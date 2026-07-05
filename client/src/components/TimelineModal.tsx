import type { MovementEvent } from '../types';

interface Props {
  open: boolean;
  fir: string | null;
  events: MovementEvent[];
  onClose: () => void;
}

export function TimelineModal({ open, fir, events, onClose }: Props) {
  return (
    <div
      className={`overlay${open ? ' open' : ''}`}
      id="timelineOverlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="timeline-card">
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        <h3>Movement Log</h3>
        <div className="fir-line">{fir ?? ''}</div>

        {events.length === 0 ? (
          <div className="tl-item">
            <div className="tl-dot">●</div>
            <div className="tl-body">
              <div className="tl-title">No movement events yet</div>
              <div className="tl-meta">This case has no recorded movements.</div>
            </div>
          </div>
        ) : events.map((ev, i) => (
          <div key={i} className="tl-item">
            <div className="tl-dot">●</div>
            <div className="tl-body">
              <div className="tl-title">{ev.title}</div>
              <div className="tl-meta">{ev.meta}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
