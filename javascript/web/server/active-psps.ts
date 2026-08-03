// Active (enabled) processors — control-plane "add / remove processors" support.
// ─────────────────────────────────────────────────────────────────────────────
// The registry (config/psp-registry.ts) is the fixed catalogue of processors the
// workshop knows how to build. This module tracks WHICH of them are currently
// enabled for the orchestrator — the store dropdown, sample cards, retry fallback,
// and the routing-rule targets all draw from the active set. It lets a presenter
// bring processors online one at a time.
//
// In-memory only (resets on restart); every registered processor starts enabled.
// ─────────────────────────────────────────────────────────────────────────────

import { listPsps, type PspName } from '../../config/psp-registry.js';

const active = new Set<PspName>(listPsps());

// Registry order, filtered to the enabled ones.
export function listActive(): PspName[] {
  return listPsps().filter((p) => active.has(p));
}

export function isActive(name: PspName): boolean {
  return active.has(name);
}

export function setActive(name: PspName, on: boolean): void {
  if (on) active.add(name);
  else active.delete(name);
}
