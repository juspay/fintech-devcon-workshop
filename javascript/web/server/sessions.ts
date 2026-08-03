// Client-session bootstrap for the browser-tokenized (PCI) checkout.
// ─────────────────────────────────────────────────────────────────────────────
// This is the connector-specific "session" glue lifted from the hyperswitch-prism
// demo store (demo/e-commerce/server/utils/auth.ts + routes/auth.ts). It runs
// BEFORE tokenization: the browser needs a per-connector session/token to boot the
// connector's own SDK (Stripe Payment Element, Adyen web components, GlobalPay
// hosted fields). Extraction of connector-specific fields is inherently
// connector-aware, so it lives here rather than in the processor-agnostic unified
// library. The FINAL authorize call still goes through unified `tokenAuthorize()`.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

import { createClientAuthToken } from '../../src/library/unified-payments.js';
import type { Order } from '../../src/library/cards.js';
import type { PspName } from '../../config/psp-registry.js';

// PSPs for which the demo ships a browser tokenization integration.
export const TOKENIZABLE_PSPS: PspName[] = ['stripe', 'adyen', 'globalpay'];

export function isTokenizable(psp: PspName): boolean {
  return TOKENIZABLE_PSPS.includes(psp);
}

export interface ClientSession {
  connector: PspName;
  clientToken: string; // Stripe client secret | Adyen session id | GlobalPay access token
  publishableKey: string; // Stripe publishable key | Adyen client key | '' for GlobalPay
  sessionData: Record<string, unknown>;
}

async function createStripeSession(order: Order): Promise<ClientSession> {
  const res = (await createClientAuthToken('stripe', order)) as any;
  return {
    connector: 'stripe',
    clientToken: res?.sessionData?.connectorSpecific?.stripe?.clientSecret?.value || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    sessionData: res as Record<string, unknown>,
  };
}

async function createAdyenSession(order: Order): Promise<ClientSession> {
  const res = (await createClientAuthToken('adyen', order)) as any;
  const adyen = res?.sessionData?.connectorSpecific?.adyen;
  return {
    connector: 'adyen',
    clientToken: adyen?.sessionId || '',
    publishableKey: process.env.ADYEN_CLIENT_KEY || '',
    sessionData: {
      sessionData: adyen?.sessionData?.value || '',
      connectorSpecific: { adyen },
    },
  };
}

// GlobalPay hosted fields authenticate with an OAuth access token minted directly
// against GlobalPay's sandbox (the demo does the same, outside the SDK).
async function fetchGlobalPayAccessToken(permissions?: string[]): Promise<string> {
  const appId = process.env.GLOBALPAY_APP_ID || '';
  const appKey = process.env.GLOBALPAY_APP_KEY || '';
  const nonce = new Date().toISOString();
  const secret = crypto.createHash('sha512').update(nonce + appKey).digest('hex');

  const body: Record<string, unknown> = {
    app_id: appId,
    secret,
    grant_type: 'client_credentials',
    nonce,
    interval_to_expire: '1_HOUR',
  };
  if (permissions && permissions.length > 0) body.permissions = permissions;

  const resp = await fetch('https://apis.sandbox.globalpay.com/ucp/accesstoken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GP-Version': '2021-03-22' },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as { token?: string; [k: string]: unknown };
  if (!data.token) {
    throw new Error(`GlobalPay access token request failed: ${JSON.stringify(data)}`);
  }
  return data.token;
}

async function createGlobalPaySession(): Promise<ClientSession> {
  const clientToken = await fetchGlobalPayAccessToken(['PMT_POST_Create_Single']);
  return { connector: 'globalpay', clientToken, publishableKey: '', sessionData: {} };
}

// Bootstrap a client session for whichever PSP the store selected/routed to.
export async function createClientSession(psp: PspName, order: Order): Promise<ClientSession> {
  switch (psp) {
    case 'stripe':
      return createStripeSession(order);
    case 'adyen':
      return createAdyenSession(order);
    case 'globalpay':
      return createGlobalPaySession();
    default:
      throw new Error(`PSP "${psp}" has no browser tokenization integration (use raw-card mode).`);
  }
}

// GlobalPay's tokenAuthorize additionally needs a server access token passed as
// state — minted the same way the demo does via the SDK session response.
export async function fetchGlobalPayServerToken(order: Order): Promise<string> {
  const res = (await createClientAuthToken('globalpay', order)) as any;
  return res?.sessionData?.connectorSpecific?.globalpay?.accessToken?.value || '';
}
