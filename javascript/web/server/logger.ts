// Structured logging for the workshop web server.
// ─────────────────────────────────────────────────────────────────────────────
// Zero-dependency. Each line is timestamped, leveled, scoped to a component, and
// carries structured key=value fields — so workshop followers can watch the
// orchestrator think in their terminal:
//
//   14:22:31.104 INFO  [store]        checkout requested   reqId=1a2b mode=raw processor=auto amount=5998 currency=USD card=****1111
//   14:22:31.106 INFO  [routing]      routed               reqId=1a2b psp=adyen reason="amount > 50.00 → adyen"
//   14:22:31.402 WARN  [orchestrator] attempt declined     reqId=1a2b n=1 psp=adyen status=ERROR error="ConnectorError: Not allowed"
//
// Env:
//   LOG_LEVEL  = debug | info | warn | error   (default: debug — verbose)
//   LOG_FORMAT = pretty | json                 (default: pretty; json for machines)
//
// NEVER pass secrets (full PAN/CVC, API keys) as fields — mask them first.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = RANK[(process.env.LOG_LEVEL as Level) in RANK ? (process.env.LOG_LEVEL as Level) : 'debug'];
const asJson = process.env.LOG_FORMAT === 'json';
const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null && !asJson;

const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const gray = paint('90');
const dim = paint('2');
const cyan = paint('36');
const LEVEL_COLOR: Record<Level, (s: string) => string> = {
  debug: paint('90'),
  info: paint('32'),
  warn: paint('33'),
  error: paint('31'),
};

export type Fields = Record<string, unknown>;

function formatFields(fields: Fields): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      let val: string;
      if (v === null || v === undefined) val = String(v);
      else if (typeof v === 'string') val = /[\s"=]/.test(v) ? JSON.stringify(v) : v;
      else if (typeof v === 'object') val = JSON.stringify(v);
      else val = String(v);
      return `${k}=${val}`;
    })
    .join(' ');
}

// Request-scoped lines (any line carrying a reqId, except the `http` boundary
// lines) are indented so a request's activity nests visually under its
// request/response lines — easy to read when there are several lines in between.
const REQUEST_INDENT = '   ';

function emit(level: Level, scope: string, msg: string, fields?: Fields): void {
  if (RANK[level] < threshold) return;
  if (asJson) {
    console.log(JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...(fields ?? {}) }));
    return;
  }
  const indent = scope !== 'http' && fields?.reqId != null ? REQUEST_INDENT : '';
  const time = gray(new Date().toISOString().slice(11, 23)); // HH:MM:SS.mmm
  const lvl = LEVEL_COLOR[level](level.toUpperCase().padEnd(5));
  const parts = [time, lvl, cyan(`[${scope}]`.padEnd(14)), msg];
  if (fields && Object.keys(fields).length) parts.push(dim(formatFields(fields)));
  console.log(indent + parts.join(' '));
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
  };
}

// Short correlation id so a request can be traced across log lines.
export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

// Skip noisy static assets / health so the log stays focused on the interesting flow.
const SKIP = /\.(css|js|map|png|ico|svg|woff2?)$/i;

// Express middleware: logs each request start (debug) and completion (info/warn/error)
// with a correlation id attached to req.reqId for the handlers to reuse.
export function requestLogger(): (req: Request, res: Response, next: NextFunction) => void {
  const log = createLogger('http');
  return (req, res, next) => {
    if (SKIP.test(req.path) || req.path === '/health' || req.path === '/favicon.ico') return next();
    const reqId = newRequestId();
    req.reqId = reqId;
    // Capture the full path once — Express rewrites req.path inside mounted routers.
    const path = (req.originalUrl || req.url).split('?')[0];
    const start = Date.now();
    log.debug(`${req.method} ${path}`, { reqId });
    res.on('finish', () => {
      const ms = Date.now() - start;
      const level: Level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      emit(level, 'http', `${req.method} ${path} → ${res.statusCode}`, { reqId, ms });
    });
    next();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      reqId?: string;
    }
  }
}
