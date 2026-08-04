// ═══════════════════════════════════════════════════════════════════════════
//  WORKSHOP STEP 2 — SWITCH THE PSP   (CLI-WALKTHROUGH.md)
//
//  This single constant decides which payment processor `npm run run:payment`
//  uses. That is the whole point of a unified library: the rest of your app
//  code never changes when you swap processors.
//
//    Step 1 : leave this as 'stripe' and run   ->  npm run run:payment
//    Step 2 : change 'stripe' to 'adyen' (one line!), then run again
//
//  Valid values are any key from PSP_REGISTRY (see config/psp-registry.ts):
//    'stripe' | 'adyen' | 'cybersource'   ('globalpay' once you enable it)
// ═══════════════════════════════════════════════════════════════════════════

import type { PspName } from './psp-registry.js';

export const ACTIVE_PSP: PspName = 'stripe';
