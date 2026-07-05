// Vercel serverless function entry point.
//
// Vercel requires the root package.json to declare `"type": "module"` so
// Node.js functions stay as native ESM (otherwise Vercel silently compiles
// them to CommonJS, and `export { default }` re-exports stop being
// recognised as the request handler — leading to FUNCTION_INVOCATION_FAILED).
//
// We re-export the Express `app` as the default export.  The bundler
// follows the import chain through `server/server.js` → `store.js` +
// `uploads.js` and packages the whole server in a single function.

import app from '../server/server.js';
export default app;
