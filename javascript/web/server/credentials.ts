// Runtime processor credentials (control-plane "layer in a processor" support).
// ─────────────────────────────────────────────────────────────────────────────
// The PSP registry reads credentials from process.env LAZILY — every
// isConfigured()/buildConfig() call re-reads process.env. So to enable a processor
// at runtime we simply set its env vars here, and the registry (and therefore the
// store's checkout) picks them up immediately, with no registry changes.
//
// This is in-memory only: overrides live in process.env for the life of the
// process and reset on restart. For persistence, put the keys in .env instead.
// Secrets are NEVER returned to the client — only a per-key "is it set?" boolean.
// ─────────────────────────────────────────────────────────────────────────────

import { getPsp, type PspName } from '../../config/psp-registry.js';

// Matches the registry's own notion of "configured": present and not a placeholder.
function isRealValue(v: string | undefined): boolean {
  const s = (v ?? '').trim();
  return s.length > 0 && !s.startsWith('your_') && !s.startsWith('sk_test_your');
}

// Apply credential values for a processor. Only keys that belong to that processor
// are accepted; an empty value clears the key.
export function setProcessorCredentials(name: PspName, values: Record<string, unknown>): void {
  const allowed = new Set(getPsp(name).envKeys);
  for (const [key, raw] of Object.entries(values)) {
    if (!allowed.has(key)) continue;
    const value = String(raw ?? '').trim();
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
}

// Per-key status for a processor — the value itself is never exposed.
export function credentialStatus(name: PspName): Array<{ key: string; set: boolean }> {
  return getPsp(name).envKeys.map((key) => ({ key, set: isRealValue(process.env[key]) }));
}
