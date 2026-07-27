// Vercel serverless function entry point.
//
// Vercel requires the root package.json to declare `"type": "module"` so
// Node.js functions stay as native ESM (otherwise Vercel silently compiles
// them to CommonJS, and `export { default }` re-exports stop being
// recognised as the request handler — leading to FUNCTION_INVOCATION_FAILED).
//
// We re-export the Express `app` as the default export, but wrap it in
// a function that AWAITS the store boot on first invocation.  This is
// the standard Vercel pattern: serverless function instances are
// short-lived, so the module-load IIFE in server.js may not finish
// before the first request lands.  Wrapping the handler with a
// `bootOnce` await guarantees getDb() is always callable by the time
// the Express routes fire.

import app from '../server/server.js';
import { boot as bootStore } from '../server/store.js';

let _bootPromise = null;
function bootOnce() {
  if (!_bootPromise) _bootPromise = bootStore().catch(e => { _bootPromise = null; throw e; });
  return _bootPromise;
}

// Neon serverless computes AUTO-SUSPENDS on idle.  The first request after a
// Vercel cold start can land while the DB is still waking up, and the Neon
// HTTP driver's `fetch` fails with a bare `TypeError: fetch failed`.  That
// used to surface as a hard `boot_failed` 500.  Retry the boot a couple of
// times with a short back-off so a transient suspend wake-up never 500s the
// user — Neon is usually reachable again within 1–2s.
async function bootWithRetry(maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // bootOnce() resets its internal promise on failure, so each retry
      // re-runs the real boot against a fresh connection.
      await bootOnce();
      if (attempt > 1) console.log(`[api/index] boot succeeded on attempt ${attempt}`);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[api/index] boot attempt ${attempt}/${maxAttempts} failed:`, e && (e.message || e));
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  try {
    await bootWithRetry();
  } catch (e) {
    // Log the real boot error so it shows up in `vercel logs` /
    // Vercel runtime logs (otherwise FUNCTION_INVOCATION_FAILED swallows
    // the actual reason).  Returns a 500 with the message in dev.
    console.error('[api/index] boot failed after retries:', e && (e.stack || e.message || e));
    res.status(500).json({ error: 'boot_failed', message: e?.message || String(e) });
    return;
  }
  return app(req, res);
};
