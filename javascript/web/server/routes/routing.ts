// Routing control-plane API (used by /control).
//   GET  /api/routing            → current plan + retry policy
//   PUT  /api/routing            → replace the plan (validated)
//   POST /api/routing/retry      → toggle the retry/fallback policy (immediate save)
//   POST /api/routing/simulate   → route a sample {minorAmount, currency} through it

import { Router } from 'express';

import { getPlan, setPlan, route, type DeclarativePlan } from '../routing-store.js';
import { isRetryEnabled, setRetryEnabled } from '../retry-policy.js';
import { persistSnapshot } from '../control-state.js';
import { createLogger } from '../logger.js';

const router = Router();
const log = createLogger('control');

router.get('/', (_req, res) => {
  res.json({ ...getPlan(), retryEnabled: isRetryEnabled() });
});

router.post('/retry', (req, res) => {
  const enabled = req.body?.enabled === true;
  setRetryEnabled(enabled);
  persistSnapshot();
  log.info('retry policy updated', { reqId: req.reqId, retryEnabled: enabled });
  res.json({ retryEnabled: isRetryEnabled() });
});

router.put('/', (req, res) => {
  const plan = req.body as DeclarativePlan;
  const err = setPlan(plan);
  if (err) {
    log.warn('routing plan rejected', { reqId: req.reqId, error: err });
    return res.status(400).json({ error: err });
  }
  persistSnapshot();
  log.info('routing plan updated', {
    reqId: req.reqId, rules: plan?.rules?.length ?? 0, fallback: plan?.fallback,
  });
  res.json(getPlan());
});

router.post('/simulate', (req, res) => {
  const minorAmount = parseInt(String(req.body?.minorAmount), 10);
  const currency = String(req.body?.currency || '').toUpperCase();
  if (Number.isNaN(minorAmount) || minorAmount <= 0 || !currency) {
    return res.status(400).json({ error: 'minorAmount (positive) and currency are required' });
  }
  const decision = route({ minorAmount, currency });
  log.debug('simulate', { reqId: req.reqId, amount: minorAmount, currency, psp: decision.psp });
  res.json(decision);
});

export default router;
