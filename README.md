# e-Malkhana — Haryana Police Digital Records

A digital case-property (malkhana) register for Haryana Police. The UI in this
project is ported **1:1** from the design file in
`Downloads/e-malkhana-ui.html` — same palette, same typography, same layout.

## Stack

- **Frontend** — React 18 + Vite + TypeScript
- **Backend**  — Express (Node.js, ESM) — single server serves both
  the JSON API (`/api/*`) and the built React app (`/*`).

## Layout

```
e-malkhana/
├── package.json            # root scripts
├── README.md
├── server/
│   ├── package.json
│   ├── server.js           # Express on :4000 — API + static frontend
│   └── data.js             # mock data (cases, alerts, timelines, racks, …)
└── client/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── styles.css      # full UI stylesheet (verbatim from the design)
        ├── api.ts          # typed fetch helpers
        ├── types.ts        # shared types
        └── components/
            ├── Letterhead.tsx
            ├── Sidebar.tsx
            ├── Dashboard.tsx
            ├── CaseProperty.tsx
            ├── Alerts.tsx
            ├── TagModal.tsx       # QR-tag evidence card
            └── TimelineModal.tsx  # movement-log card
```

## Run it (one port, one command)

```bash
# from C:\Users\gsash\e-malkhana
npm run install:all      # one-time: installs root + server + client
npm run build            # build the React app → client/dist
npm start                # start the unified server on :4000
```

Then open **<http://localhost:4000>** — that's it.

## Security & demo accounts

The repo ships with three **passwordless demo accounts** (`MM-001`, `MM-002`,
`MM-003`) so the login screen has something to show.  The `/api/login`
endpoint treats an empty/missing `password` field as "no password required" —
fine for offline demos, **not safe for any real deployment**.

For production, set real passwords in one of two ways:

1. **After first boot**, edit `server/data/db.json` and add a `password` key
   to each user object.  Restart the server.
2. **At boot**, set the `MM_USERS` env var (see `.env.example`) with a JSON
   array of fully-configured user records.  When set, it replaces the seed
   users entirely.

> ℹ️  `server/data/` is `.gitignore`d — your local `db.json` (with real
> passwords) will never be committed.

## Run in dev mode (with hot reload)

```bash
npm run dev              # runs API on :4000 AND Vite dev server on :5173
                         # Vite proxies /api/* to :4000
```

Then open <http://localhost:5173>.

## API

| Method | Path                   | Returns                                |
| ------ | ---------------------- | -------------------------------------- |
| GET    | `/api/health`          | `{ ok, service, time }`                |
| GET    | `/api/dashboard`       | officer, racks, stats, recent, alerts  |
| GET    | `/api/cases`           | all case-property rows                 |
| GET    | `/api/alerts`          | full alert list (FSL, expert, court…)  |
| GET    | `/api/timeline/:fir`   | movement-log events for one case       |

## UI fidelity

The design uses a very specific palette (ink-navy + khaki + seal-red on paper)
and ledger-style status stamps. The stylesheet in `client/src/styles.css` is
copied verbatim from the original HTML and is the single source of truth.
