# Workshop walkthrough (JavaScript / TypeScript)

This is the hands-on guide. Each section maps to a step in the workshop agenda.
Total time: ~45–60 minutes. Everything runs locally with `tsx` (no build step).

> **Credentials are optional.** Every demo runs without keys — you'll see the
> request being built and sent, then a connector error instead of a charge. Add
> sandbox keys in `.env` to see real approvals. The **test suite needs no keys**.

---

## Step 0 — Prerequisites (one-time)

Make sure these are installed before the workshop:

| Tool | Version | Check |
|------|---------|-------|
| Git | any recent | `git --version` |
| Node.js | 18+ (LTS) | `node --version` |
| npm | ships with Node | `npm --version` |

Platform: Linux x64, macOS, or Windows via **WSL2**. The `hyperswitch-prism` SDK
ships a native **x86_64** library, so on Apple Silicon / ARM use Docker or WSL2
with an x86_64 runtime (see the SDK README for platform notes). No Rust toolchain
is required — the SDK is installed prebuilt from npm.

---

## Step 0.1 — Clone the workshop repository

```bash
# 1. Clone
git clone https://github.com/juspay/fintech-devcon-workshop.git
cd fintech-devcon-workshop

# 2. Go to the JavaScript workshop folder
cd javascript
```

> Already have the repo cloned? Just run step 2.

Verify you're in the right place — you should see `package.json`, `config/`,
`src/`, and `test/`:

```bash
ls
# README.md  STEPS.md  config  package.json  src  test  tsconfig.json ...
```

---

## Step 0.2 — Install dependencies

```bash
npm install                 # pulls hyperswitch-prism (the unified SDK) + tsx
cp .env.example .env        # optional: add sandbox keys for the PSPs you have
```

`npm install` downloads the SDK with its prebuilt native library — no build step.
This is the only network-heavy step; do it before the session if Wi‑Fi is slow.

**Sanity check** (should print the test summary, no credentials needed):

```bash
npm test
# ...
# # tests 17
# # pass 17
# # fail 0
```

If you see `17 pass`, your environment is ready. 🎉

---

## Step 1 & 2 — Run a payment and view the experience with PSP-1 (Stripe)

```bash
npm run run:payment
```

You'll see the unified library run a full **authorize → refund** lifecycle
through **Stripe** (the default `ACTIVE_PSP`). With a real `STRIPE_API_KEY` the
authorize returns `CHARGED` and the refund returns `REFUND_SUCCESS`/`REFUND_PENDING`.

> The "payment experience" is the console output: status, transaction id, and
> any error — all normalized by the library regardless of processor.

**What to look at:** `src/steps/step1-run-payment.ts` and `src/library/unified-payments.ts`.
Notice the app code never mentions "Stripe" — it just calls `authorize(ACTIVE_PSP, order)`.

Watch the console for the **`🔷 prism`** callouts: each one brackets a real
`hyperswitch-prism` SDK call (method, PSP, elapsed ms), marking the exact moment the
unified library hands off to the SDK. That's the only place prism is invoked — everything
else in the workshop is processor-agnostic. (Set `PRISM_TRACE=off` to hide them.)

---

## Step 3 — Switch the PSP from PSP-1 to PSP-2 (the minimal change)

Open **`config/active-psp.ts`** and change exactly one line:

```diff
- export const ACTIVE_PSP: PspName = 'stripe';
+ export const ACTIVE_PSP: PspName = 'adyen';
```

That's the entire change. No application, orchestrator, or request code is touched.

---

## Step 4 — Re-run with PSP-2 (Adyen)

```bash
npm run run:payment
```

Same command, same code — now the library drives **Adyen**. This is the core
lesson: **the processor is a configuration detail, not a code dependency.**

> Switch it back to `'stripe'` (or try `'cybersource'`) and run again to feel how
> cheap swapping processors becomes with a unified library.

---

## Step 6a — Condition-based routing (payment orchestrator)

```bash
npm run run:routing
```

Three sample carts are fed through one **routing plan**:

| Cart | Rule that matches | PSP chosen |
|------|-------------------|-----------|
| $15.00 USD | none → fallback | Stripe |
| €20.00 EUR | EUR currency | Cybersource |
| $99.00 USD | amount > $50.00 | Adyen |

The decision logic lives in **`src/orchestrator/routing.ts`** as a **pure
function** `selectPsp(plan, ctx)`. Edit `DEFAULT_ROUTING_PLAN` to add your own
rules (e.g. route GBP somewhere, or route by amount band).

---

## Step 6b — Payment retry / fallback (payment orchestrator)

```bash
npm run run:retry
```

This combines routing **and** retry: routing picks the primary PSP, then
`withRetry` tries it first and **falls back** to the other PSPs until one
approves (or all are exhausted). Watch the per-attempt log.

The retry engine is **`src/orchestrator/retry.ts`** — also pure and
processor-agnostic (it takes an `attempt` callback). That's what makes it
robust and testable.

---

## Step 7 — Extend the library: new processor and/or new flow

```bash
npm run run:extend
```

**(A) Add a new processor** — we added `cybersource` as PSP-3. Adding a
processor is a single entry in **`config/psp-registry.ts`**; routing, retry, and
all demos pick it up automatically. **Try it:** add a 4th processor from the SDK
(e.g. `bluesnap`, `nuvei`, `globalpay`) by copying an existing registry entry and
adjusting its auth fields.

**(B) Add a new flow** — we added `voidPayment()` to
**`src/library/unified-payments.ts`** and exercised a new composite flow:
`authorize(MANUAL)` → `void`. Every flow follows the same shape (build client →
call SDK method → normalize result), so adding `capture`, `sync`, `dispute`,
etc. follows the same recipe.

---

## Step 8 — Run the test suite (prove the change is robust)

```bash
npm test
```

17 unit tests, **no credentials or network required**:

- `test/routing.test.ts` — routing picks the right PSP for every condition,
  including rule precedence and threshold edges.
- `test/retry.test.ts` — retry stops at first success, exhausts correctly,
  honors `maxAttempts`, and fires `onAttempt` per try (driven by fakes).
- `test/unified-payments.test.ts` — result normalization maps SDK statuses to
  `ok` / `pending` / error correctly.

Also available: `npm run typecheck` (full TypeScript check).

> **Try the red→green loop:** flip a rule in `routing.ts`, run `npm test`, watch
> it fail, then fix it. That's the "ensure the change is robust" muscle.

---

## File map

```
javascript/
├── config/
│   ├── active-psp.ts        ← Step 3: the one-line PSP switch
│   └── psp-registry.ts      ← Step 7A: add a processor here (only place)
├── src/
│   ├── library/
│   │   ├── unified-payments.ts  ← the unified library (authorize/capture/refund/void)
│   │   ├── cards.ts             ← test cards + sample order
│   │   └── format.ts            ← output helpers
│   ├── orchestrator/
│   │   ├── routing.ts           ← Step 6a: condition-based routing (pure)
│   │   └── retry.ts             ← Step 6b: retry/fallback (pure)
│   └── steps/
│       ├── step1-run-payment.ts ← Steps 1–4
│       ├── step2-routing.ts     ← Step 6a demo
│       ├── step3-retry.ts       ← Step 6b demo
│       └── step4-extend.ts      ← Step 7 demo
├── test/                        ← Step 8: the test suite
└── web/                         ← Step 9: the web experience (npm run web)
    ├── server/                  ← Express app: /store + /control + /api
    ├── orchestration-config.json        ← tracked control-plane state (every /control edit writes it)
    └── client/                  ← storefront, checkout, control-plane UI
```

---

## Step 9 — See it in a browser: store + control plane

Everything so far is CLI. This step puts the SAME unified library and orchestrator
behind a web experience, so participants can watch routing happen in a real
e-commerce checkout.

```bash
npm run web
```

Then open two URLs:

- **http://localhost:3000/store** — an e-commerce storefront and checkout. The
  checkout has a **request-configuration** panel:
  - **Card handling:** _PCI (tokenized)_ — the processor's own SDK collects the card
    in hosted fields and the browser sends only a token — vs _Raw card (non-PCI)_ —
    a test card posted to the server. **Both** finish through the unified library
    (`tokenAuthorize` vs `authorize`), which is the whole point.
  - **Processor:** _Automatic_ (route by the control-plane rules) or a specific PSP.
  - **Retry/fallback** (raw + Automatic): try the routed PSP first, then the others.
  The result panel shows the full orchestration trace (routed-to, reason, each attempt).

- **http://localhost:3000/control** — the **control plane**: edit the condition-based
  routing rules (the same `RoutingPlan`/`selectPsp` from Step 6a, now made editable and
  served from memory), pick the fallback, and simulate a route. Saving is immediately
  honored by the store's Automatic mode.

> **Start empty and build up.** The workshop ships with **no rules, no fallback, and no
> enabled processors** — a clean slate. So the orchestrator is assembled live, in order:
>
> 1. **Add a processor** in `/control` → Processors (🔑 add its keys, or Add it to the
>    active set). Repeat to bring processors online one at a time.
> 2. **Set a fallback** (or add a rule) so payments have somewhere to route.
> 3. Check out in `/store` and watch the trace.
>
> Before a processor is enabled and something routes, a checkout returns a "no processor"
> error — that's the empty state, by design.

> **This step is still hands-on.** The CLI steps (1–8) are the *edit-code-by-hand* track;
> step 9 is the *see-it-live* track — they don't replace each other. And they meet in one
> file: **every `/control` change writes `web/orchestration-config.json`**, a git-tracked file. So
> after each edit, inspect what happened by hand:
>
> ```bash
> git diff web/orchestration-config.json     # exactly what your click changed
> cat web/orchestration-config.json          # the declarative rule model behind the UI
> ```
>
> It's two-way: hand-edit `web/orchestration-config.json` and the running server reloads it into
> the UI. `git checkout web/orchestration-config.json` resets the plan to the workshop default.

> No credentials? Raw-card mode still runs end-to-end (you'll see a connector error
> instead of a charge). The PCI path needs each connector's sandbox keys — see
> `web/README.md`. **GlobalPay** was added to the registry (`config/psp-registry.ts`)
> exactly like Cybersource in Step 7, so the demo's Stripe/Adyen/GlobalPay browser
> tokenization is reused as-is; Cybersource is raw-card only.
