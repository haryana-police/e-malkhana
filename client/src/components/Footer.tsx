interface Props {
  /** Year to show in the copyright line. */
  year?: number;
}

export function Footer({ year }: Props) {
  const yr = year ?? new Date().getFullYear();
  return (
    <footer className="app-footer">
      <div className="app-footer-copy">
        © Haryana Police {yr} All Rights Reserved
      </div>
    </footer>
  );
}
