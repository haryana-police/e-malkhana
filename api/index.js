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

export default async function handler(req, res) {
  try {
    await bootOnce();
  } catch (e) {
    // Log the real boot error so it shows up in `vercel logs` /
    // Vercel runtime logs (otherwise FUNCTION_INVOCATION_FAILED swallows
    // the actual reason).  Returns a 500 with the message in dev.
    console.error('[api/index] boot failed:', e && (e.stack || e.message || e));
    res.status(500).json({ error: 'boot_failed', message: e?.message || String(e) });
    return;
  }
  return app(req, res);
};
