// Retry / fallback policy — a control-plane setting.
// ─────────────────────────────────────────────────────────────────────────────
// When enabled, the store's Automatic routing tries the routed processor first and
// then falls back across the other ENABLED processors until one approves (the retry
// orchestrator, src/orchestrator/retry.ts). It only applies to processor-agnostic
// checkout — a browser (PCI) token is pinned to the connector chosen at session time.
//
// In-memory; persisted to web/.control-state.json alongside the plan + enabled set.
// ─────────────────────────────────────────────────────────────────────────────

let enabled = false; // off by default — turn it on in /control to demo retry

export function isRetryEnabled(): boolean {
  return enabled;
}

export function setRetryEnabled(on: boolean): void {
  enabled = Boolean(on);
}
