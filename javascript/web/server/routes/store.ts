// Store API — the checkout surface for both payment modes.
// ─────────────────────────────────────────────────────────────────────────────
//   GET  /api/store/products         → catalog
//   POST /api/store/checkout         → RAW card (non-PCI): authorize (+ retry)
//   GET  /api/store/session          → PCI bootstrap: client session for the routed PSP
//   POST /api/store/token-authorize  → PCI finalize: tokenAuthorize with the browser token
//
// Both modes end at the workshop's unified library (authorize / tokenAuthorize) and
// reuse the orchestrator: routing via routing-store.route() (the /control plan) and,
// for raw mode, retry via withRetry()/buildPlan(). The request-level "processor"
// field is either 'auto' (route by condition) or a specific PSP name.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Response } from 'express';
import { IntegrationError, ConnectorError, NetworkError } from 'hyperswitch-prism';
import { v4 as uuidv4 } from 'uuid';

import { PRODUCTS } from '../products.js';
import { route } from '../routing-store.js';
import { authorize, tokenAuthorize, type UnifiedResult } from '../../../src/library/unified-payments.js';
import { withRetry, buildPlan } from '../../../src/orchestrator/retry.js';
import { APPROVED_CARD, DECLINED_CARD, type Order, type TestCard } from '../../../src/library/cards.js';
import { getPsp, listPsps, type PspName } from '../../../config/psp-registry.js';
import { listActive, isActive } from '../active-psps.js';
import { isRetryEnabled } from '../retry-policy.js';
import { createClientSession, fetchGlobalPayServerToken, isTokenizable } from '../sessions.js';
import { createLogger } from '../logger.js';

const router = Router();
const log = createLogger('store');
const routeLog = createLogger('routing');
const orch = createLogger('orchestrator');
const pciLog = createLogger('pci');

// Mask a PAN to the last 4 digits — NEVER log full card numbers or CVC.
const maskPan = (pan: string): string => `****${String(pan || '').replace(/\D/g, '').slice(-4)}`;

const KNOWN_PSPS = new Set<PspName>(listPsps());
const isPsp = (v: unknown): v is PspName => typeof v === 'string' && KNOWN_PSPS.has(v as PspName);

function newTxnId(): string {
  return `txn_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
}

function pickCard(card: unknown): TestCard {
  if (card && typeof card === 'object' && 'cardNumber' in (card as any)) return card as TestCard;
  return card === 'declined' ? DECLINED_CARD : APPROVED_CARD;
}

// Flatten a UnifiedResult into the compact attempt shape the store UI renders.
function toAttempt(r: UnifiedResult) {
  return {
    psp: r.psp,
    displayName: getPsp(r.psp).displayName,
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    transactionId: r.transactionId ?? null,
    error: r.error ?? null,
  };
}

// Classify + log a PCI session/authorize failure so the cause is visible in the
// server terminal AND returned to the browser with an actionable message.
function sendSdkError(res: Response, connector: PspName, e: unknown, reqId?: string): Response {
  pciLog.error('connector call failed', { reqId, connector, error: e instanceof Error ? e.message : String(e) });
  const code = (e as { errorCode?: unknown })?.errorCode;
  if (e instanceof IntegrationError) {
    return res.status(400).json({ error: `Integration error: ${e.message}`, code, connector });
  }
  if (e instanceof ConnectorError) {
    return res.status(502).json({ error: `Connector error: ${e.message}`, code, connector });
  }
  if (e instanceof NetworkError) {
    return res.status(502).json({
      error: `Network error contacting ${getPsp(connector).displayName}: ${e.message}. ` +
        `Check connectivity and that the sandbox credentials in .env are valid.`,
      connector,
    });
  }
  const msg = e instanceof Error ? e.message : 'failed to create session';
  return res.status(502).json({ error: msg, connector });
}

// ── Catalog ─────────────────────────────────────────────────────────────────
router.get('/products', (_req, res) => {
  res.json({ products: PRODUCTS });
});

// ── RAW card (non-PCI) checkout ─────────────────────────────────────────────
router.post('/checkout', async (req, res) => {
  const minorAmount = parseInt(String(req.body?.minorAmount), 10);
  const currency = String(req.body?.currency || '').toUpperCase();
  const processor = req.body?.processor; // 'auto' | PspName
  const card = pickCard(req.body?.card);

  if (Number.isNaN(minorAmount) || minorAmount <= 0 || !currency) {
    return res.status(400).json({ error: 'minorAmount (positive) and currency are required' });
  }
  const automatic = processor === 'auto' || processor === undefined;
  if (!automatic && !isPsp(processor)) {
    return res.status(400).json({ error: `unknown processor "${processor}"` });
  }
  if (!automatic && !isActive(processor)) {
    return res.status(400).json({ error: `${getPsp(processor).displayName} is not an enabled processor.` });
  }
  // Retry/fallback is a control-plane policy and only meaningful when routing (Automatic).
  const retryEnabled = automatic && isRetryEnabled();
  const reqId = req.reqId;

  const order: Order = { merchantTransactionId: newTxnId(), minorAmount, currency, card };
  log.info('checkout requested', {
    reqId, mode: 'raw', processor: automatic ? 'auto' : String(processor),
    amount: minorAmount, currency, retry: retryEnabled, card: maskPan(card.cardNumber), txn: order.merchantTransactionId,
  });

  // Decide the primary PSP: routed (Automatic) or the one the shopper pinned.
  let primary: PspName;
  let reason: string;
  if (automatic) {
    // Raw mode has the card, so card/BIN rules can be evaluated here.
    const decision = route({ minorAmount, currency, cardNumber: card.cardNumber });
    if (!decision.psp) {
      routeLog.warn('no route', { reqId, reason: decision.reason });
      return res.status(409).json({
        error: 'No processor matched this payment and no fallback is set. Add a routing rule or set a ' +
          'fallback in the control plane, or pick a specific processor.',
      });
    }
    primary = decision.psp;
    reason = decision.reason;
    routeLog.info('routed', { reqId, psp: primary, reason });
  } else {
    primary = processor as PspName;
    reason = `manually selected ${getPsp(primary).displayName}`;
    routeLog.debug('processor pinned', { reqId, psp: primary });
  }

  const logAttempt = (n: number, r: UnifiedResult) =>
    orch[r.ok ? 'info' : 'warn'](r.ok ? 'attempt approved' : 'attempt declined',
      { reqId, n, psp: r.psp, status: r.statusText, ok: r.ok, ...(r.error ? { error: r.error } : {}) });

  // Always run through the same orchestrator path: the retry plan is just the
  // primary alone when retry is off, or the primary followed by the other enabled
  // PSPs when it's on. (No branch guarding authorization on a user-provided flag.)
  const plan = retryEnabled ? buildPlan(primary, listActive().filter((p) => p !== primary)) : [primary];
  orch.debug('attempt plan', { reqId, plan: plan.join(' → ') });

  try {
    const result = await withRetry({
      plan,
      attempt: (psp) => authorize(psp, order),
      onAttempt: (_psp, i, outcome) => logAttempt(i + 1, outcome),
    });
    log[result.succeeded ? 'info' : 'warn']('checkout complete',
      { reqId, succeeded: result.succeeded, winningPsp: result.winningPsp, attempts: result.attempts.length });
    return res.json({
      mode: 'raw',
      automatic,
      retryEnabled,
      routedTo: primary,
      reason,
      succeeded: result.succeeded,
      winningPsp: result.winningPsp,
      merchantTransactionId: order.merchantTransactionId,
      attempts: result.attempts.map((a) => toAttempt(a.outcome)),
    });
  } catch (e) {
    log.error('checkout error', { reqId, error: e instanceof Error ? e.message : String(e) });
    return res.status(500).json({ error: e instanceof Error ? e.message : 'checkout failed' });
  }
});

// ── PCI (tokenized) bootstrap: routing resolves HERE, at session time ────────
router.get('/session', async (req, res) => {
  const minorAmount = parseInt(String(req.query?.amount ?? req.query?.minorAmount), 10);
  const currency = String(req.query?.currency || '').toUpperCase();
  const processor = req.query?.processor; // 'auto' | PspName

  if (Number.isNaN(minorAmount) || minorAmount <= 0 || !currency) {
    return res.status(400).json({ error: 'amount (positive) and currency are required' });
  }
  const automatic = processor === 'auto' || processor === undefined;
  if (!automatic && !isPsp(processor)) {
    return res.status(400).json({ error: `unknown processor "${processor}"` });
  }
  if (!automatic && !isActive(processor)) {
    return res.status(400).json({ error: `${getPsp(processor).displayName} is not an enabled processor.` });
  }

  const reqId = req.reqId;
  log.info('session requested', {
    reqId, mode: 'tokenized', processor: automatic ? 'auto' : String(processor), amount: minorAmount, currency,
  });

  let psp: PspName;
  let reason: string;
  if (automatic) {
    const decision = route({ minorAmount, currency });
    if (!decision.psp) {
      routeLog.warn('no route', { reqId, reason: decision.reason });
      return res.status(409).json({
        error: 'No processor matched this payment and no fallback is set. Add a routing rule or set a ' +
          'fallback in the control plane.',
      });
    }
    psp = decision.psp;
    reason = decision.reason;
    routeLog.info('routed', { reqId, psp, reason });
  } else {
    psp = processor as PspName;
    reason = `manually selected ${getPsp(psp).displayName}`;
    routeLog.debug('processor pinned', { reqId, psp });
  }

  if (!isTokenizable(psp)) {
    pciLog.warn('session blocked', { reqId, connector: psp, why: 'no processor-specific integration' });
    return res.status(409).json({
      error: `${getPsp(psp).displayName} has no processor-specific tokenization integration in this demo. ` +
        `Switch to processor-agnostic mode, or route/select a processor that supports it (Stripe, Adyen, GlobalPay).`,
      connector: psp,
      tokenizable: false,
    });
  }

  // The PCI path must call the connector to bootstrap a client session, so unlike
  // raw-card mode it cannot degrade gracefully without credentials. Fail early with
  // an actionable message instead of a raw network/connector error.
  if (!getPsp(psp).isConfigured()) {
    pciLog.warn('session blocked', { reqId, connector: psp, why: 'no credentials configured' });
    return res.status(400).json({
      error: `${getPsp(psp).displayName} has no sandbox credentials configured. Add its keys to ` +
        `javascript/.env (copy .env.example — see web/README.md) to use processor-specific ` +
        `tokenization. Processor-agnostic mode works without keys.`,
      connector: psp,
      configured: false,
    });
  }

  const order: Order = { merchantTransactionId: newTxnId(), minorAmount, currency, card: APPROVED_CARD };
  try {
    const session = await createClientSession(psp, order);
    pciLog.info('session created', { reqId, connector: psp, txn: order.merchantTransactionId });
    return res.json({
      connector: psp,
      reason,
      automatic,
      merchantTransactionId: order.merchantTransactionId,
      amount: minorAmount,
      currency,
      clientToken: session.clientToken,
      publishableKey: session.publishableKey,
      sessionData: session.sessionData,
    });
  } catch (e) {
    return sendSdkError(res, psp, e, reqId);
  }
});

// ── PCI (tokenized) finalize: unified tokenAuthorize with the browser token ──
router.post('/token-authorize', async (req, res) => {
  const token = req.body?.token;
  const merchantTransactionId = req.body?.merchantTransactionId;
  const minorAmount = parseInt(String(req.body?.amount), 10);
  const currency = String(req.body?.currency || '').toUpperCase();
  const connector = req.body?.connector;

  if (!token || !merchantTransactionId || Number.isNaN(minorAmount) || minorAmount <= 0 || !currency || !isPsp(connector)) {
    return res.status(400).json({ error: 'token, merchantTransactionId, amount, currency and a known connector are required' });
  }

  const reqId = req.reqId;
  log.info('token-authorize', { reqId, connector, amount: minorAmount, currency, txn: merchantTransactionId });

  const order: Order = { merchantTransactionId, minorAmount, currency, card: APPROVED_CARD };
  try {
    const opts = connector === 'globalpay'
      ? { serverAccessToken: await fetchGlobalPayServerToken(order) }
      : {};
    const result = await tokenAuthorize(connector, order, token, opts);
    orch[result.ok ? 'info' : 'warn'](result.ok ? 'tokenized charge approved' : 'tokenized charge declined',
      { reqId, connector, status: result.statusText, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
    return res.json({
      mode: 'tokenized',
      routedTo: connector,
      succeeded: result.ok,
      status: result.status,
      statusText: result.statusText,
      transactionId: result.transactionId ?? null,
      error: result.error ?? null,
    });
  } catch (e) {
    return sendSdkError(res, connector, e, reqId);
  }
});

export default router;
