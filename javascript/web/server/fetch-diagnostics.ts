// Outbound-fetch diagnostics.
// ─────────────────────────────────────────────────────────────────────────────
// The payment SDK calls the connector via the global fetch(), but on failure it
// reports only "Network Error: fetch failed" — the real reason lives in
// error.cause.code, which it discards. This wraps global fetch to log that cause
// (and a plain-language hint) BEFORE the SDK swallows it, then re-throws the
// original error unchanged. Purely diagnostic; on success it's a passthrough.
// ─────────────────────────────────────────────────────────────────────────────

import { createLogger } from './logger.js';

const log = createLogger('net');

function hintFor(code?: string): string | undefined {
  switch (code) {
    case 'UND_ERR_INVALID_ARG':
      return "undici version mismatch (the SDK's v6 dispatcher vs the runtime's fetch) — this fails before any " +
        "network. The undici@6 shim (src/library/undici-compat.ts) should prevent it; if you see this, the shim " +
        "didn't load. Node 18–22 also avoids it.";
    case 'ENOTFOUND':
      return 'DNS lookup failed — check your network/DNS.';
    case 'ECONNREFUSED':
      return 'connection refused.';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'connection timed out — check network / proxy / firewall.';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'TLS certificate problem — check proxy / VPN.';
    default:
      return undefined;
  }
}

export function installFetchDiagnostics(): void {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;

  const wrapped = async (...args: Parameters<typeof original>) => {
    try {
      return await original(...args);
    } catch (e) {
      const input = args[0] as unknown;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as { url?: string })?.url ?? String(input);
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const code = cause?.code ?? (e as { code?: string })?.code ?? 'unknown';
      const hint = hintFor(cause?.code ?? (e as { code?: string })?.code);
      log.warn('outbound request failed', {
        url,
        code,
        detail: cause?.message ?? (e as Error)?.message,
        ...(hint ? { hint } : {}),
      });
      throw e;
    }
  };

  globalThis.fetch = wrapped as typeof globalThis.fetch;
}
