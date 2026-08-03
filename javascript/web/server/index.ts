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

import { createLogger, requestLogger } from './logger.js';
import { hydrateFromDisk } from './control-state.js';
import { installFetchDiagnostics } from './fetch-diagnostics.js';
import storeRoutes from './routes/store.js';
import routingRoutes from './routes/routing.js';
import pspRoutes from './routes/psps.js';

const log = createLogger('server');

// Surface the real cause of outbound connector-call failures (the SDK only reports
// "fetch failed"); see web/server/fetch-diagnostics.ts.
installFetchDiagnostics();

// Restore the routing plan + enabled processors from disk (if present) before serving.
hydrateFromDisk();

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

// The hyperswitch-prism SDK ships an undici@6 HTTP dispatcher and hands it to the
// global fetch(). Node 23+ bundles undici 7, whose handler interface changed, so
// that dispatcher is rejected with `UND_ERR_INVALID_ARG: invalid onError method`
// and EVERY connector call fails as "Network Error: fetch failed". Warn loudly so
// this doesn't look like a network/credential problem. Use Node 18/20/22 LTS.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 23) {
  log.warn(
    `Node ${process.versions.node}: the SDK's undici@6 dispatcher is incompatible with Node 23+ ` +
    `(undici 7) — real payments will fail with "Network Error: fetch failed". Use Node 20 or 22 LTS (see .nvmrc).`,
    { node: process.versions.node },
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
