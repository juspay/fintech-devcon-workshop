// /api/refund — process a refund through the unified library (hyperswitch-prism).
//   POST /api/refund  { psp, connectorTransactionId, minorAmount, currency, merchantTransactionId? }
//
// Drives the control-plane "Refund a payment" panel. A payment made in /store returns
// a connector transaction id; paste it here, pick the processor that handled it, and
// this calls the unified refund() — the SAME library flow as authorize/capture/void.
//
// The refund flow ships DISABLED (see the stub in src/library/unified-payments.ts).
// Until it's enabled during the workshop, refund() returns a NOT_ENABLED result, which
// this surfaces with a clear message instead of failing.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { refund } from '../../../src/library/unified-payments.js';
import { APPROVED_CARD, type Order } from '../../../src/library/cards.js';
import { getPsp, listPsps, type PspName } from '../../../config/psp-registry.js';
import { isActive } from '../active-psps.js';
import { createLogger } from '../logger.js';

const router = Router();
const log = createLogger('refund');
const KNOWN = new Set<PspName>(listPsps());
const isPsp = (v: unknown): v is PspName => typeof v === 'string' && KNOWN.has(v as PspName);

router.post('/', async (req, res) => {
  const psp = req.body?.psp;
  const connectorTransactionId = String(req.body?.connectorTransactionId || '').trim();
  const minorAmount = parseInt(String(req.body?.minorAmount), 10);
  const currency = String(req.body?.currency || '').toUpperCase();
  const merchantTransactionId =
    String(req.body?.merchantTransactionId || '').trim() ||
    `refund_${uuidv4().replace(/-/g, '').substring(0, 16)}`;

  if (!isPsp(psp)) return res.status(400).json({ error: `unknown processor "${psp}"` });
  if (!isActive(psp)) {
    return res.status(400).json({ error: `${getPsp(psp).displayName} is not an enabled processor.` });
  }
  if (!connectorTransactionId) {
    return res.status(400).json({ error: 'connectorTransactionId (from the payment result) is required' });
  }
  if (Number.isNaN(minorAmount) || minorAmount <= 0 || !currency) {
    return res.status(400).json({ error: 'a positive amount and a currency are required' });
  }

  const reqId = req.reqId;
  const order: Order = { merchantTransactionId, minorAmount, currency, card: APPROVED_CARD };
  log.info('refund requested', { reqId, psp, txn: connectorTransactionId, amount: minorAmount, currency });

  try {
    // refund() never throws — it normalizes SDK errors (and the NOT_ENABLED stub) into a result.
    const result = await refund(psp, order, connectorTransactionId, minorAmount);
    log[result.ok ? 'info' : 'warn'](result.ok ? 'refund succeeded' : 'refund not completed', {
      reqId, psp, status: result.statusText, ok: result.ok, ...(result.error ? { error: result.error } : {}),
    });
    return res.json({
      psp,
      displayName: getPsp(psp).displayName,
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      enabled: result.statusText !== 'NOT_ENABLED',
      transactionId: result.transactionId ?? connectorTransactionId,
      error: result.error ?? null,
    });
  } catch (e) {
    log.error('refund error', { reqId, psp, error: e instanceof Error ? e.message : String(e) });
    return res.status(500).json({ error: e instanceof Error ? e.message : 'refund failed' });
  }
});

export default router;
