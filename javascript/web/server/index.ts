// Workshop web experience — one Express app, two pages.
// ─────────────────────────────────────────────────────────────────────────────
//   http://localhost:3000/store    → e-commerce storefront + checkout
//   http://localhost:3000/control  → routing control plane (edit the rules)
//
// The store and control plane share one process, so the in-memory routing plan
// edited in /control is immediately honored by /store's Automatic routing.
//
//   npm run web
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import { createLogger, requestLogger, currentReqId } from './logger.js';
import { hydrateFromDisk, watchPlanFile } from './control-state.js';
import { installFetchDiagnostics } from './fetch-diagnostics.js';
import { setPrismTraceSink } from '../../src/library/prism-trace.js';
import storeRoutes from './routes/store.js';
import routingRoutes from './routes/routing.js';
import pspRoutes from './routes/psps.js';
import refundRoutes from './routes/refund.js';

const log = createLogger('server');

// Surface the real cause of outbound connector-call failures (the SDK only reports
// "fetch failed"); see web/server/fetch-diagnostics.ts.
installFetchDiagnostics();

// Render every hyperswitch-prism SDK call through the structured logger as scope
// [prism], so the SDK boundary stands out in the same terminal as the rest of the
// flow (see src/library/prism-trace.ts). Set PRISM_TRACE=off to silence it.
const prismLog = createLogger('prism');
setPrismTraceSink((e) => {
  // reqId (via async context) both correlates the line to its request AND makes it
  // indent under that request, like the store/routing/orchestrator lines.
  const reqId = currentReqId();
  if (e.phase === 'invoke') {
    prismLog.info(`→ ${e.client}.${e.method}()`, { reqId, psp: e.psp });
  } else {
    prismLog[e.ok ? 'info' : 'warn'](`← ${e.client}.${e.method}()`,
      { reqId, psp: e.psp, ms: e.ms, ...(e.ok ? {} : { error: e.error }) });
  }
});

// Restore the routing plan + enabled processors from disk (if present) before serving,
// then watch web/orchestration-config.json so hand edits to it reload into the running UI.
hydrateFromDisk();
watchPlanFile();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientPath = path.join(__dirname, '..', 'client');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger()); // structured per-request logging (see web/server/logger.ts)

// Basic rate limiting on every route (generous — this is a local workshop app, but
// it keeps the endpoints from being hammered and satisfies standard security checks).
app.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));

// API
app.use('/api/store', storeRoutes);
app.use('/api/routing', routingRoutes);
app.use('/api/psps', pspRoutes);
app.use('/api/refund', refundRoutes);

// Clean page URLs (registered before static so the URL stays as-is)
app.get('/', (_req, res) => res.redirect('/store'));
app.get('/store', (_req, res) => res.sendFile(path.join(clientPath, 'store', 'index.html')));
app.get('/store/checkout', (_req, res) => res.sendFile(path.join(clientPath, 'store', 'checkout.html')));
app.get('/control', (_req, res) => res.sendFile(path.join(clientPath, 'control', 'index.html')));

// Static assets: /store/js/*, /control/js/*, /shared/styles.css
app.use(express.static(clientPath));

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// The hyperswitch-prism SDK hands its bundled undici@6 dispatcher to the global
// fetch(). When the runtime's built-in undici is NOT v6 (some Node 23/24 builds ship
// undici 7, whose Dispatcher interface differs), that dispatcher can be rejected with
// `UND_ERR_INVALID_ARG: invalid onError method` → "Network Error: fetch failed".
// src/library/undici-compat.ts handles this by routing the SDK's calls through
// undici@6 on any non-v6 runtime; here we just note when that shim is in effect.
const builtinUndiciMajor = Number((process.versions.undici ?? '').split('.')[0]);
if (builtinUndiciMajor !== 6) {
  log.info(
    `Node ${process.versions.node} bundles undici ${process.versions.undici}; ` +
    `the undici@6 compatibility shim is active for SDK calls (see src/library/undici-compat.ts).`,
    { node: process.versions.node, undici: process.versions.undici },
  );
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Workshop web experience running at http://localhost:${PORT}`);
  console.log(`   🛒 Store          →  http://localhost:${PORT}/store`);
  console.log(`   🎛️  Control plane  →  http://localhost:${PORT}/control`);
  console.log(`\n   Raw-card (non-PCI) mode works with no credentials — you'll see a`);
  console.log(`   connector error instead of a charge. Add sandbox keys to .env for`);
  console.log(`   real approvals and the PCI (tokenized) mode.\n`);
  log.info('server started', {
    port: PORT,
    node: process.versions.node,
    logLevel: process.env.LOG_LEVEL || 'debug',
    logFormat: process.env.LOG_FORMAT || 'pretty',
  });
});
