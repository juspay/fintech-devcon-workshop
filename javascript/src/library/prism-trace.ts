// hyperswitch-prism call tracer — a visible callout at every SDK boundary.
// ─────────────────────────────────────────────────────────────────────────────
// The whole workshop wraps hyperswitch-prism in ONE module (unified-payments.ts).
// This tracer wraps each actual SDK method call so that — in the CLI steps and in
// the web server terminal — you can literally point at the screen and say
// "there: that line is where we hand off to prism." Every real network call the
// SDK makes is bracketed by an → invoke and a ← result line (with elapsed ms and
// success/failure), so the SDK boundary is impossible to miss during a demo.
//
// The sink is swappable so each surface renders it natively:
//   - CLI steps  → a bright emoji banner on the console (default sink below).
//   - web server → routed through the structured logger as scope [prism]
//                  (see web/server/index.ts, which calls setPrismTraceSink()).
//
// Set PRISM_TRACE=off to silence it entirely.
// ─────────────────────────────────────────────────────────────────────────────

import type { PspName } from '../../config/psp-registry.js';

export interface PrismCall {
  client: 'PaymentClient' | 'MerchantAuthenticationClient';
  method: string; // e.g. authorize, tokenAuthorize, capture, void, refund
  psp: PspName;
}

export type PrismTraceEvent =
  | ({ phase: 'invoke' } & PrismCall)
  | ({ phase: 'result'; ms: number; ok: boolean; error?: string } & PrismCall);

export type PrismTraceSink = (event: PrismTraceEvent) => void;

const enabled = process.env.PRISM_TRACE !== 'off';

// Default sink: an unmistakable console banner for the CLI workshop steps.
const BADGE = '🔷 prism';
function consoleSink(e: PrismTraceEvent): void {
  if (e.phase === 'invoke') {
    console.log(`${BADGE} → hyperswitch-prism ${e.client}.${e.method}()  psp=${e.psp}`);
  } else {
    const tail = e.ok ? `ok in ${e.ms}ms` : `FAILED in ${e.ms}ms — ${e.error ?? 'error'}`;
    console.log(`${BADGE} ← ${e.client}.${e.method}()  psp=${e.psp}  ${tail}`);
  }
}

let sink: PrismTraceSink = consoleSink;

// Swap the sink (the web server routes prism calls through its structured logger).
export function setPrismTraceSink(next: PrismTraceSink): void {
  sink = next;
}

// Wrap a single hyperswitch-prism SDK call: emit an invoke line, run it, then emit
// a result line with timing and outcome. Re-throws so callers keep their own
// error handling (unified-payments normalizes thrown SDK errors into results).
export async function tracePrism<T>(call: PrismCall, run: () => Promise<T>): Promise<T> {
  if (!enabled) return run();
  sink({ phase: 'invoke', ...call });
  const start = Date.now();
  try {
    const result = await run();
    sink({ phase: 'result', ...call, ms: Date.now() - start, ok: true });
    return result;
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    sink({ phase: 'result', ...call, ms: Date.now() - start, ok: false, error });
    throw e;
  }
}
