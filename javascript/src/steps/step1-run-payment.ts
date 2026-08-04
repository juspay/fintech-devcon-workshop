// WORKSHOP STEPS 1–2 — run a payment, then switch the PSP   (CLI-WALKTHROUGH.md)
// ─────────────────────────────────────────────────────────────────────────────
//   Step 1: run this with the default PSP   ->  npm run run:payment
//           (read the output — that's the normalized "payment experience")
//   Step 2: open config/active-psp.ts, change ACTIVE_PSP 'stripe' -> 'adyen'
//           (one line), then run it again    ->  npm run run:payment
//
// Notice the application code here does NOT change between steps 1 and 2. The
// unified library makes the processor an interchangeable detail.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';

import { ACTIVE_PSP } from '../../config/active-psp.js';
import { getPsp } from '../../config/psp-registry.js';
import { authorize, refund } from '../library/unified-payments.js';
import { APPROVED_CARD, type Order } from '../library/cards.js';
import { banner, step, money } from '../library/format.js';

async function main() {
  const psp = getPsp(ACTIVE_PSP);

  banner(`Running a payment through PSP: ${psp.displayName}  (ACTIVE_PSP = '${ACTIVE_PSP}')`);

  if (!psp.isConfigured()) {
    step(
      `No sandbox credentials found for ${psp.displayName} ` +
        `(expected env: ${psp.envKeys.join(', ')}).`,
    );
    step('The request will still be built and sent — expect a connector auth error.');
    step('Add your keys to .env to see a real approval. Continuing anyway...\n');
  }

  const order: Order = {
    merchantTransactionId: `workshop_${Date.now()}`,
    minorAmount: 1000, // $10.00
    currency: 'USD',
    card: APPROVED_CARD,
  };

  // ── Authorize + capture (one step) ─────────────────────────────────────────
  step(`Authorizing ${money(order.minorAmount, order.currency)} on card ****${order.card.cardNumber.slice(-4)} ...`);
  const auth = await authorize(ACTIVE_PSP, order);

  console.log(`    → status      : ${auth.statusText} (${auth.status})`);
  console.log(`    → transaction : ${auth.transactionId ?? '—'}`);
  if (auth.error) console.log(`    → error       : ${auth.error}`);

  if (!auth.ok || !auth.transactionId) {
    banner(`Payment not approved by ${psp.displayName}. (See error above.)`);
    return;
  }

  // ── Refund the payment we just made ────────────────────────────────────────
  // Note: the refund flow ships DISABLED (a workshop exercise — see the stub in
  // src/library/unified-payments.ts). Until it's enabled, this reports NOT_ENABLED.
  step(`Refunding ${money(order.minorAmount, order.currency)} for ${auth.transactionId} ...`);
  const ref = await refund(ACTIVE_PSP, order, auth.transactionId);
  console.log(`    → refund status : ${ref.statusText} (${ref.status})`);
  if (ref.error) console.log(`    → note          : ${ref.error}`);

  if (ref.statusText === 'NOT_ENABLED') {
    banner(`Authorize succeeded. Refund is not enabled yet — turn it on during the workshop.`);
  } else {
    banner(`Done. PSP '${ACTIVE_PSP}' handled the full authorize → refund lifecycle.`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
