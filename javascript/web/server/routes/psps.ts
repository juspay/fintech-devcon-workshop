// /api/psps — enumerate processors, configure credentials, and enable/disable them.
//   GET  /api/psps                    → all registered processors (+ enabled flag, keys)
//   PUT  /api/psps/:name/credentials  → set a processor's keys (layer it in live)
//   POST /api/psps/:name/enable       → add the processor to the active set
//   POST /api/psps/:name/disable      → remove it (blocked if a routing rule needs it)
//
// Drives the store's processor dropdown and the control-plane processor manager.

import { Router } from 'express';

import { PSP_REGISTRY, listPsps, type PspName } from '../../../config/psp-registry.js';
import { isTokenizable } from '../sessions.js';
import { setProcessorCredentials, credentialStatus } from '../credentials.js';
import { isActive, setActive } from '../active-psps.js';
import { getPlan } from '../routing-store.js';
import { persistSnapshot } from '../control-state.js';
import { createLogger } from '../logger.js';

const router = Router();
const log = createLogger('control');
const KNOWN = new Set<PspName>(listPsps());

function describe(name: PspName) {
  const entry = PSP_REGISTRY[name];
  return {
    name,
    displayName: entry.displayName,
    currencies: entry.currencies,
    enabled: isActive(name),
    configured: entry.isConfigured(),
    tokenizable: isTokenizable(name), // has a browser (processor-specific) integration?
    envKeys: entry.envKeys,
    credentials: credentialStatus(name), // [{ key, set }] — never the secret itself
  };
}

// Rules/fallback in the saved routing plan that would dangle if `name` is removed.
function routingReferences(name: PspName): string[] {
  const plan = getPlan();
  const refs: string[] = [];
  plan.rules.forEach((r, i) => { if (r.use === name) refs.push(`rule ${i + 1}`); });
  if (plan.fallback === name) refs.push('the fallback');
  return refs;
}

router.get('/', (_req, res) => {
  res.json({ psps: listPsps().map(describe) });
});

// Set (or clear) a processor's credentials at runtime. Empty value clears a key.
router.put('/:name/credentials', (req, res) => {
  const name = req.params.name as PspName;
  if (!KNOWN.has(name)) return res.status(404).json({ error: `unknown processor "${name}"` });

  const values = (req.body && typeof req.body === 'object' ? (req.body.values ?? req.body) : null) as
    | Record<string, unknown>
    | null;
  if (!values || typeof values !== 'object') {
    return res.status(400).json({ error: 'a "values" object of { envKey: value } is required' });
  }

  setProcessorCredentials(name, values);
  // Log only which keys changed — NEVER the secret values.
  log.info('credentials updated', { reqId: req.reqId, psp: name, keys: Object.keys(values), configured: PSP_REGISTRY[name].isConfigured() });
  res.json(describe(name));
});

router.post('/:name/enable', (req, res) => {
  const name = req.params.name as PspName;
  if (!KNOWN.has(name)) return res.status(404).json({ error: `unknown processor "${name}"` });
  setActive(name, true);
  persistSnapshot();
  log.info('processor enabled', { reqId: req.reqId, psp: name });
  res.json(describe(name));
});

router.post('/:name/disable', (req, res) => {
  const name = req.params.name as PspName;
  if (!KNOWN.has(name)) return res.status(404).json({ error: `unknown processor "${name}"` });

  const refs = routingReferences(name);
  if (refs.length > 0) {
    log.warn('processor disable blocked', { reqId: req.reqId, psp: name, usedBy: refs.join(', ') });
    return res.status(409).json({
      error: `${PSP_REGISTRY[name].displayName} is used by ${refs.join(' and ')} in the routing plan. ` +
        `Update the plan first, then remove it.`,
    });
  }
  setActive(name, false);
  persistSnapshot();
  log.info('processor disabled', { reqId: req.reqId, psp: name });
  res.json(describe(name));
});

export default router;
