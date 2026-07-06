interface Props {
  /** Click on the Home link — navigate to the dashboard. */
  onHome?: () => void;
  /** Year to show in the copyright line. */
  year?: number;
}

export function Footer({ onHome, year }: Props) {
  const yr = year ?? new Date().getFullYear();
  return (
    <footer className="app-footer">
      <nav className="app-footer-links" aria-label="Footer">
        <button
          type="button"
          className="app-footer-link"
          onClick={onHome}
          title="Go to Dashboard"
        >
          <span className="app-footer-link-icon" aria-hidden="true">⌂</span>
          <span>Home</span>
        </button>
      </nav>
      <div className="app-footer-copy">
        © Haryana Police {yr} All Rights Reserved
      </div>
    </footer>
  );
}
