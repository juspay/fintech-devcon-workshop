# CLI walkthrough — the pure-terminal track (JavaScript / TypeScript)

This is the **pure-CLI track**: the same concepts as the browser workshop, exercised
from the terminal by **editing code and running `npm` scripts**. Nothing here needs the
web app.

- **Following the workshop?** The guided, browser-based sequence and the one-time setup
  live in the **[root README](../README.md)** — start there.
- **Want to see how the code is built?** The architecture, codebase map, and request-flow
  diagram are in **[javascript/README.md](./README.md)**.
- **The browser experience** (store + control plane) is covered in
  **[web/README.md](./web/README.md)**.

> **Setup:** follow *Start here* in the [root README](../README.md) (`npm install`, then
> `npm test` to verify). **Credentials are optional** — every demo builds and sends the
> request and shows a connector error instead of a charge; the test suite needs no keys.
> Everything runs locally via `tsx` (no build step).

Watch for the **`🔷 prism`** callouts in the output of every step: each brackets a real
`hyperswitch-prism` SDK call (method, PSP, elapsed ms), marking the exact hand-off to the
SDK — the only place prism is invoked. (`PRISM_TRACE=off` hides them.)

---

## Step 1 — Run a payment with one processor

```bash
npm run run:payment
```

The unified library runs a full **authorize → refund** lifecycle through **Stripe** (the
default `ACTIVE_PSP`). With a real `STRIPE_API_KEY` the authorize returns `CHARGED`; the
refund is disabled by default (see Step 5B) and reports `NOT_ENABLED` until you turn it on.

**What to look at:** `src/steps/step1-run-payment.ts` and `src/library/unified-payments.ts`.
Notice the app code never mentions "Stripe" — it just calls `authorize(ACTIVE_PSP, order)`.
The "payment experience" is the console output: status, transaction id, and any error, all
normalized by the library regardless of processor.

---

## Step 2 — Switch the processor in one line

Open **`config/active-psp.ts`** and change exactly one line:

```diff
- export const ACTIVE_PSP: PspName = 'stripe';
+ export const ACTIVE_PSP: PspName = 'adyen';
```

Re-run — same command, same application code, now driving **Adyen**:

```bash
npm run run:payment
```

That's the core lesson: **the processor is a configuration detail, not a code dependency.**
Switch it back to `'stripe'` (or try `'cybersource'`) and run again.

---

## Step 3 — Condition-based routing

```bash
npm run run:routing
```

Three sample carts flow through one **routing plan**:

| Cart | Rule that matches | PSP chosen |
|------|-------------------|-----------|
| $15.00 USD | none → fallback | Stripe |
| €20.00 EUR | EUR currency | Cybersource |
| $99.00 USD | amount > $50.00 | Adyen |

The decision logic is a **pure function** `selectPsp(plan, ctx)` in
**`src/orchestrator/routing.ts`**. Edit `DEFAULT_ROUTING_PLAN` to add your own rules
(route GBP somewhere, or route by amount band).

---

## Step 4 — Retry / fallback

```bash
npm run run:retry
```

Routing picks the primary PSP, then `withRetry` tries it and **falls back** across the
other PSPs until one approves (or all are exhausted). Watch the per-attempt log. The retry
engine is **`src/orchestrator/retry.ts`** — also pure and processor-agnostic (it takes an
`attempt` callback), which is what makes it robust and testable.

---

## Step 5 — Extend the library: a new processor and a new flow

```bash
npm run run:extend
```

**(A) Add a new processor.** `cybersource` (PSP-3) is a worked example already in
**`config/psp-registry.ts`**. **GlobalPay** is the hands-on exercise: it ships
**commented out** at the bottom of `PSP_REGISTRY`. Un-comment that one entry — routing,
retry, the demos, and (in the web app) the `/control` processor list pick it up
automatically. Adding *any* processor is the same single-entry change.

**(B) Add a new flow.** `voidPayment()` in **`src/library/unified-payments.ts`** is a
worked example (`authorize(MANUAL)` → `void`). **`refund()` ships disabled** as the live
exercise — delete its stub and un-comment the real implementation just below it. Every
flow follows the same shape (build client → call SDK method → normalize result), so
`capture`, `sync`, `dispute`, … all follow the same recipe.

---

## Step 6 — Run the test suite (prove the change is robust)

```bash
npm test
```

17 unit tests, **no credentials or network required**:

- `test/routing.test.ts` — routing picks the right PSP for every condition, including rule
  precedence and threshold edges.
- `test/retry.test.ts` — retry stops at first success, exhausts correctly, honors
  `maxAttempts`, and fires `onAttempt` per try (driven by fakes).
- `test/unified-payments.test.ts` — result normalization maps SDK statuses to
  `ok` / `pending` / error correctly.

Also available: `npm run typecheck` (full TypeScript check).

> **Try the red→green loop:** flip a rule in `routing.ts`, run `npm test`, watch it fail,
> then fix it. That's the "ensure the change is robust" muscle.

---

## Next: see it in the browser

Everything above is CLI. The **web experience** puts the *same* unified library and
orchestrator behind an e-commerce store and a routing control plane — where each change
you make is written to a git-tracked config file you can `git diff`. Run `npm run web`
and follow the [root README](../README.md) sequence; the internals are in
[web/README.md](./web/README.md).
