// Vercel serverless function entry point.
// Re-exports the Express app from server/server.js so every /api/* request
// hits the same routing as the local `node server.js` dev process.
//
// On Vercel the function is stateless and `/tmp` is per-instance, so:
//   - db.json resets on cold start
//   - uploaded files reset on cold start
// This is acceptable for a demo deployment; production needs Vercel KV /
// Postgres + Vercel Blob.  See README for details.

export { default } from '../server/server.js';
