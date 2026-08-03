// Persistence for control-plane state (routing plan + enabled processors).
// ─────────────────────────────────────────────────────────────────────────────
// Survives restarts by mirroring the in-memory state to a small JSON file. Only
// the ROUTING PLAN and the ENABLED-PROCESSOR SET are persisted — never secrets.
// Credentials remain in process.env / .env only and are never written here.
//
// Route handlers call persistSnapshot() after a successful mutation; the server
// calls hydrateFromDisk() once at boot. The file lives at web/.control-state.json
// (outside web/client, so it is never served) and is gitignored.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPlan, setPlan, type DeclarativePlan } from './routing-store.js';
import { listActive, setActive } from './active-psps.js';
import { listPsps, type PspName } from '../../config/psp-registry.js';
import { createLogger } from './logger.js';

const log = createLogger('persist');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', '.control-state.json');

interface PersistedState {
  version: number;
  plan: DeclarativePlan;
  enabled: PspName[];
}

// Write the current in-memory plan + enabled set to disk. Best-effort — a failed
// write logs a warning but never breaks the request.
export function persistSnapshot(): void {
  const state: PersistedState = { version: 1, plan: getPlan(), enabled: listActive() };
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    log.debug('control state saved', { rules: state.plan.rules.length, enabled: state.enabled.length });
  } catch (e) {
    log.warn('failed to persist control state', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Restore plan + enabled set from disk at boot (if the file exists and is valid).
// Applies the enabled set FIRST so the plan validates against it.
export function hydrateFromDisk(): void {
  if (!fs.existsSync(FILE)) return;

  let parsed: Partial<PersistedState>;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    log.warn('control state file is unreadable — using defaults', { error: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (Array.isArray(parsed.enabled)) {
    const wanted = new Set(parsed.enabled);
    for (const p of listPsps()) setActive(p, wanted.has(p));
  }

  if (parsed.plan) {
    const err = setPlan(parsed.plan);
    if (err) log.warn('persisted routing plan is invalid — using default', { error: err });
  }

  log.info('control state restored from disk', {
    file: path.relative(process.cwd(), FILE),
    rules: getPlan().rules.length,
    enabled: listActive().join(','),
  });
}
