// x402-INSPIRED checkout handshake (processor-agnostic card path).
// ─────────────────────────────────────────────────────────────────────────────
// This borrows the HTTP *shape* of the x402 protocol (https://x402.org): the server
// answers an unpaid request with `402 Payment Required` + an `accepts` list, the
// client retries with an `X-PAYMENT` header carrying a base64 JSON payload, and the
// server "settles" and returns an `X-PAYMENT-RESPONSE` header.
//
// It is deliberately **NOT interoperable with real x402**. Real x402 settles on-chain:
// its X-PAYMENT payload is a *signed stablecoin transfer authorization* (EIP-3009 &c.)
// with schemes `exact`/`upto`/`batch-settlement`, verified by a facilitator. Here we
// define a custom **`card` scheme** whose payload carries CARD DETAILS, so we can demo
// the 402 → X-PAYMENT round-trip over the existing card rails (hyperswitch-prism) —
// no wallet, no chain, no facilitator. Think "x402-shaped envelope over cards."
// ─────────────────────────────────────────────────────────────────────────────

import type { TestCard } from '../../src/library/cards.js';
import type { PspName } from '../../config/psp-registry.js';

export const X402_VERSION = 1;
export const X402_SCHEME = 'card' as const;

export interface X402CardPayment {
  x402Version: number;
  scheme: typeof X402_SCHEME;
  minorAmount: number;
  currency: string;
  processor: string; // 'auto' | PspName
  card: TestCard | 'approved' | 'declined';
}

export interface X402Accept {
  scheme: string; // 'card'
  network: string; // 'processor-agnostic' — NOT a blockchain
  maxAmountRequired: string; // minor units, as a string (x402 convention)
  currency: string;
  processors: string[]; // processors the shopper may pick, plus 'auto'
  resource: string;
  description: string;
}

export interface X402Requirements {
  x402Version: number;
  kind: 'x402-inspired-demo';
  note: string;
  accepts: X402Accept[];
}

// Build the `402 Payment Required` body advertising how to pay.
export function buildRequirements(opts: {
  minorAmount: number;
  currency: string;
  processors: PspName[];
}): X402Requirements {
  return {
    x402Version: X402_VERSION,
    kind: 'x402-inspired-demo',
    note: 'x402-INSPIRED handshake: a custom `card` scheme over card rails — NOT interoperable on-chain x402.',
    accepts: [
      {
        scheme: X402_SCHEME,
        network: 'processor-agnostic',
        maxAmountRequired: String(opts.minorAmount),
        currency: opts.currency,
        processors: ['auto', ...opts.processors],
        resource: '/api/store/checkout',
        description: `Card payment of ${opts.minorAmount} ${opts.currency} minor units via a chosen or auto-routed processor.`,
      },
    ],
  };
}

// Decode + validate the X-PAYMENT header. Returns { payment } or { error }.
export function decodePayment(header: string): { payment?: X402CardPayment; error?: string } {
  let json: string;
  try {
    json = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    return { error: 'X-PAYMENT is not valid base64' };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return { error: 'X-PAYMENT payload is not valid JSON' };
  }
  if (obj?.scheme !== X402_SCHEME) {
    return { error: `unsupported x402 scheme "${String(obj?.scheme)}" — this demo only accepts the "${X402_SCHEME}" scheme` };
  }
  const minorAmount = parseInt(String(obj.minorAmount), 10);
  const currency = String(obj.currency || '').toUpperCase();
  if (Number.isNaN(minorAmount) || minorAmount <= 0 || !currency) {
    return { error: 'X-PAYMENT must include a positive minorAmount and a currency' };
  }
  return {
    payment: {
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      minorAmount,
      currency,
      processor: typeof obj.processor === 'string' ? obj.processor : 'auto',
      card: obj.card as X402CardPayment['card'],
    },
  };
}

// A small settlement receipt for the X-PAYMENT-RESPONSE header (mirrors x402's shape).
export function encodeReceipt(receipt: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64');
}
