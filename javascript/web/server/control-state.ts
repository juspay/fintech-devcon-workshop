// Persistence for control-plane state (routing plan + enabled processors).
// ─────────────────────────────────────────────────────────────────────────────
// Survives restarts by mirroring the in-memory state to a small JSON file. Only
// the ROUTING PLAN and the ENABLED-PROCESSOR SET are persisted — never secrets.
// Credentials remain in process.env / .env only and are never written here.
//
// The file is web/routing-plan.json — a VISIBLE, git-TRACKED artifact (not a
// hidden dotfile). Every /control change rewrites it, so a workshop attendee can
// watch it change in their working tree and `git diff` exactly what a click did.
// It is also HAND-EDITABLE: watchPlanFile() reloads the file when it changes on
// disk, so editing routing-plan.json by hand is reflected in the running UI (on
// its next load). This makes the control plane a two-way, touch-and-feel surface.
//
// Route handlers call persistSnapshot() after a successful mutation; the server
// calls hydrateFromDisk() then watchPlanFile() once at boot. The file lives at
// web/routing-plan.json (outside web/client, so it is never served).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPlan, setPlan, type DeclarativePlan } from './routing-store.js';
import { listActive, setActive } from './active-psps.js';
import { isRetryEnabled, setRetryEnabled } from './retry-policy.js';
import { listPsps, type PspName } from '../../config/psp-registry.js';
import { createLogger } from './logger.js';

const log = createLogger('persist');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..');
const FILE_NAME = 'routing-plan.json';
const FILE = path.join(DIR, FILE_NAME);
// Pre-web-9 builds wrote a hidden dotfile; read it once so upgrading doesn't reset state.
const LEGACY_FILE = path.join(DIR, '.control-state.json');

interface PersistedState {
  version: number;
  plan: DeclarativePlan;
  enabled: PspName[];
  retryEnabled?: boolean;
}

// Restrict any string written to disk to a safe identifier charset. The plan is
// already validated by setPlan(), but reconstructing the persisted object from
// sanitized/whitelisted values keeps untrusted input from reaching the file.
const clean = (s: unknown): string => String(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

// The last file content we produced or ingested. Used to tell our OWN writes
// (which also fire the watcher) apart from a genuine hand-edit, and to avoid
// re-hydrating the same content twice.
let lastContent = '';

function serialize(): string {
  const plan = getPlan();
  const state = {
    version: 1,
    plan: {
      rules: plan.rules.map((r) => ({
        id: clean(r.id),
        field: r.field === 'currency' ? 'currency' : r.field === 'card' ? 'card' : 'amount',
        operator: clean(r.operator),
        value: r.field === 'amount' ? Number(r.value) || 0 : clean(r.value),
        use: clean(r.use),
      })),
      fallback: plan.fallback === null ? null : clean(plan.fallback),
    },
    enabled: listActive().map(clean),
    retryEnabled: isRetryEnabled(),
  };
  return JSON.stringify(state, null, 2) + '\n';
}

// Write the current in-memory plan + enabled set to disk. Best-effort — a failed
// write logs a warning but never breaks the request.
export function persistSnapshot(): void {
  const content = serialize();
  try {
    fs.writeFileSync(FILE, content);
    lastContent = content; // so the watcher ignores this write as a hand-edit
    log.debug('routing plan saved', { file: FILE_NAME });
  } catch (e) {
    log.warn('failed to persist control state', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Apply a parsed state object to the in-memory plan + enabled set + retry policy.
// Enabled set is applied FIRST so the plan validates against it.
function apply(parsed: Partial<PersistedState>): void {
  if (Array.isArray(parsed.enabled)) {
    const wanted = new Set(parsed.enabled);
    for (const p of listPsps()) setActive(p, wanted.has(p));
  }
  if (parsed.plan) {
    const err = setPlan(parsed.plan);
    if (err) log.warn('routing plan is invalid — keeping the previous one', { error: err });
  }
  if (typeof parsed.retryEnabled === 'boolean') setRetryEnabled(parsed.retryEnabled);
}

// Restore plan + enabled set from disk at boot (if the file exists and is valid).
// Falls back to the legacy dotfile once, so older checkouts keep their state.
export function hydrateFromDisk(): void {
  let source = FILE;
  if (!fs.existsSync(FILE)) {
    if (fs.existsSync(LEGACY_FILE)) source = LEGACY_FILE;
    else return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (e) {
    log.warn('routing plan file is unreadable — using defaults', { error: e instanceof Error ? e.message : String(e) });
    return;
  }

  let parsed: Partial<PersistedState>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn('routing plan file is not valid JSON — using defaults', { error: e instanceof Error ? e.message : String(e) });
    return;
  }

  apply(parsed);
  lastContent = source === FILE ? raw : ''; // migrating from legacy → force a fresh write below
  if (source === LEGACY_FILE) {
    log.info('migrated state from legacy .control-state.json → routing-plan.json');
    persistSnapshot();
  }

  log.info('routing plan restored from disk', {
    file: path.relative(process.cwd(), FILE),
    rules: getPlan().rules.length,
    enabled: listActive().join(','),
    retry: isRetryEnabled(),
  });
}

// Watch routing-plan.json for HAND edits and reload them into the running server,
// so editing the file by hand is a first-class way to drive the control plane.
// We watch the directory (survives editors that save via rename) and debounce.
// Our own writes are ignored by comparing against lastContent.
export function watchPlanFile(): void {
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.watch(DIR, (_event, filename) => {
      if (filename && filename !== FILE_NAME) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        let raw: string;
        try {
          raw = fs.readFileSync(FILE, 'utf8');
        } catch {
          return; // file removed mid-edit; ignore
        }
        if (raw === lastContent) return; // our own write, or already ingested
        let parsed: Partial<PersistedState>;
        try {
          parsed = JSON.parse(raw);
        } catch {
          log.warn('hand-edited routing-plan.json is not valid JSON — ignoring until fixed');
          return;
        }
        apply(parsed);
        lastContent = raw;
        log.info('routing plan reloaded from a hand edit', {
          file: FILE_NAME, rules: getPlan().rules.length, enabled: listActive().join(','), retry: isRetryEnabled(),
        });
      }, 150);
    });
    log.debug('watching routing-plan.json for hand edits', { file: FILE_NAME });
  } catch (e) {
    log.warn('could not watch routing-plan.json (hand-edit reload disabled)', { error: e instanceof Error ? e.message : String(e) });
  }
}
