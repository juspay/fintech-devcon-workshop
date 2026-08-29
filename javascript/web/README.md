# Web experience — store + control plane (workshop step 9)

Puts the workshop's **unified library** and **orchestrator** (routing + retry) behind
a browser experience, so participants can watch routing happen in a real checkout.

```bash
cd javascript
npm install        # Node 18+ (the undici note below is handled automatically)
npm run web
```

- **http://localhost:3000/store** — e-commerce storefront + checkout
- **http://localhost:3000/control** — routing control plane

> **ℹ️ Node & undici (handled automatically).** The `hyperswitch-prism` SDK builds an
> `undici@6` HTTP dispatcher and hands it to the global `fetch()`. On runtimes whose
> built-in undici isn't v6 (some Node 23/24 builds ship undici 7, whose dispatcher
> interface differs — `UND_ERR_INVALID_ARG: invalid onError method`), that would surface
> as `Network Error: fetch failed`. **A compatibility shim** (`src/library/undici-compat.ts`,
> imported first by `unified-payments.ts`) routes the SDK's calls through undici 6 on any
> non-v6 runtime, so **Node 18+ just works** — CLI and web alike. The shim is a no-op on
> Node 18–22; when it activates it logs one `[undici-compat]` line.

Both pages are served by one Express process (`web/server/index.ts`), so the routing
plan you edit in `/control` is immediately used by the store's Automatic mode (shared
in-memory state, restored at boot from `web/orchestration-config.json`).

> **Empty by design.** The workshop ships with no rules, no fallback, and no enabled
> processors (see the [root README](../../README.md) sequence). So until you add a
> processor in `/control` and something routes, a checkout returns a *"no processor"*
> error — that's the empty state, not a bug. `git checkout web/orchestration-config.json`
> returns you to the clean slate.

## The store checkout — request-level configuration

- **Card handling**
  - **PCI (tokenized):** the selected processor's own SDK (Stripe Payment Element,
    Adyen web components, GlobalPay hosted fields) collects the card in the browser and
    returns a token; the server calls the unified `tokenAuthorize()`. The card never
    touches our server.
  - **Raw card (non-PCI):** a test card is posted to the server, which calls the unified
    `authorize()`.
  - Either way the **final call goes through the unified library** — this toggle is a
    live demo of orchestrating with vs without PCI compliance.
- **Processor:** _Automatic_ (route by the `/control` rules) or a specific PSP.

The result panel prints the full **orchestration trace**: which PSP was routed to and
why, and every attempt with its normalized status.

### x402-inspired checkout handshake (processor-agnostic) — internal demo

> **Not part of the workshop steps, and not real x402.** This is a demo overlay that
> borrows the **HTTP shape** of the [x402 protocol](https://x402.org) over the existing
> card rails. Real x402 settles **on-chain** — its `X-PAYMENT` payload is a signed
> stablecoin transfer authorization (schemes `exact`/`upto`/`batch-settlement`), verified
> by a facilitator. Here we define a custom **`card` scheme** whose payload carries card
> details, so there is no wallet, chain, or facilitator. See `web/server/x402.ts`.

The processor-agnostic **Pay** button now runs a two-step handshake instead of a single POST:

1. `POST /api/store/checkout` with the order intent (no card) → server replies
   **`402 Payment Required`** with an `accepts` list (amount, currency, the enabled
   processors + `auto`).
2. The browser resubmits with an **`X-PAYMENT`** header — base64 JSON
   `{ scheme: "card", minorAmount, currency, processor, card }` — and the server decodes
   it and settles through the **same** `authorize()` / `withRetry()` path as before,
   returning an **`X-PAYMENT-RESPONSE`** receipt header. Routing, retry, and BIN rules are
   unchanged.

The store result panel shows the handshake steps; the server logs them under the `[x402]`
scope. The **processor-specific (PCI)** flow is untouched.

**Retry / fallback** is a **control-plane policy** (toggle in `/control`): when on,
Automatic routing tries the routed PSP first, then the others in registry order until one
approves. It only applies to **processor-agnostic** checkout — a browser token is pinned
to the connector chosen at session time, so the tokenized flow can't retry a different PSP.

## The control plane

Edit the condition-based routing rules — the same `RoutingPlan` / `selectPsp` from step
6a, made **declarative and editable** (`{ field: amount | currency | card, operator, value → PSP }`)
and compiled back into `selectPsp`. **Amount** and **currency** are merchant attributes;
a **Card number** rule matches the shopper's card by prefix (`starts with`, i.e. BIN) — a
customer attribute — to demonstrate routing on payment-method data. Card rules apply to
**processor-agnostic** checkout only (the tokenized flow captures the card after routing,
so the server doesn't have it yet). Reorder rules (first match wins), set the fallback
(or **None** for a clean slate — an unmatched payment then has no route and the store
returns a "no processor" error), and simulate a route. Save is validated server-side.
With fallback **None**, no rules, and all processors removed, you can start the workshop
from zero and layer everything in.

A **Retry / fallback** toggle (saved immediately) sets the global retry policy: when on,
Automatic routing falls back across the other enabled processors if the routed one
declines (processor-agnostic checkout only — see above).

**Layer in processors live.** The **Processors** panel manages which processors the
orchestrator can use:
- **🔑 keys** — enter a processor's sandbox keys and **Save**; it flips to `configured`
  and the store can use it immediately. Works because the registry reads credentials
  from `process.env` lazily, so the control plane just sets them at runtime
  (`PUT /api/psps/:name/credentials`). Secrets are never returned to the browser (only a
  per-key "set" status).
- **Remove / Add** — take a processor out of the active set or add it back, one at a time
  (`POST /api/psps/:name/{disable,enable}`). Removed processors leave the store dropdown,
  sample cards, retry fallback, and the routing-rule targets. A processor that a routing
  rule or the fallback references **can't** be removed until you update the plan (the API
  returns 409), so the routing plan never dangles.

**Persistence — a tracked, hand-editable file.** The **routing plan** and the
**enabled-processor set** are saved to `web/orchestration-config.json` on every change and
restored at boot. Unlike a hidden runtime dotfile, this is a **git-tracked file in your
working tree**, so it doubles as a hands-on teaching artifact: after any `/control`
action, run `git diff web/orchestration-config.json` to see exactly what your click did, or
`cat` it to read the declarative rule model. It's **two-way** — edit the file by hand
and the server reloads it into the running UI (shown on the control page's next load).
`git checkout web/orchestration-config.json` resets the plan + enabled set to the workshop
default. **Credentials are never written there** — secrets stay in `process.env` /
`.env` only and reset on restart (edit `.env` to persist keys).

## Refund a payment (enable a new flow, live)

The **Refund** panel in `/control` refunds a payment through the unified library — the
same `hyperswitch-prism` flow as authorize/capture. Make a payment in `/store`, copy the
**transaction id** from the result panel, then in `/control` pick the processor that
handled it, paste the id + amount, and **Process refund**.

The refund flow **ships disabled on purpose** — it's the "enable a new flow" exercise.
`src/library/unified-payments.ts` has a stub `refund()` that returns `NOT_ENABLED`, with
the real implementation commented out just below it. Until you enable it, the Refund
panel (and `npm run run:payment`) report *"Refund flow is not enabled yet."* To turn it
on during the workshop:

1. In `src/library/unified-payments.ts`, **delete the stub `refund()`** and
   **un-comment the real one** beneath it.
2. Save — the server restarts (`tsx watch`), and the Refund panel now processes refunds
   through prism. Watch for the `🔷 prism … PaymentClient.refund()` callout in the logs.

`POST /api/refund { psp, connectorTransactionId, minorAmount, currency }` backs the panel.
A refund only runs through an **enabled** processor.

## Server logs (follow along in the terminal)

The server emits **structured logs** so you can watch the orchestrator work. A raw
checkout with retry looks like:

```
14:22:31.104 INFO  [http]            POST /api/store/checkout    reqId=1a2b3c
14:22:31.105 INFO  [store]           checkout requested   reqId=1a2b3c mode=raw processor=auto amount=5998 currency=USD retry=true card=****1111
14:22:31.106 INFO  [routing]         routed   reqId=1a2b3c psp=adyen reason="amount > 50.00 → adyen"
14:22:31.106 INFO  [prism]        → PaymentClient.authorize()   psp=adyen
14:22:31.402 WARN  [prism]        ← PaymentClient.authorize()   psp=adyen ms=296 error="ConnectorError: Not allowed"
14:22:31.402 WARN  [orchestrator]    attempt declined   reqId=1a2b3c n=1 psp=adyen status=ERROR error="ConnectorError: Not allowed"
14:22:31.403 INFO  [prism]        → PaymentClient.authorize()   psp=stripe
14:22:31.640 INFO  [prism]        ← PaymentClient.authorize()   psp=stripe ms=237
14:22:31.640 INFO  [orchestrator]    attempt approved   reqId=1a2b3c n=2 psp=stripe status=CHARGED
14:22:31.641 INFO  [store]           checkout complete   reqId=1a2b3c succeeded=true winningPsp=stripe attempts=2
14:22:31.642 INFO  [http]            POST /api/store/checkout → 200  reqId=1a2b3c ms=538
```

The **`[prism]` lines are the SDK boundary** — the `→` / `←` pair brackets each real
`hyperswitch-prism` call (which client, which method, which PSP, and how long it took),
so during the workshop you can point at the terminal and say "*there* — that's where we
hand off to prism." They come from `src/library/prism-trace.ts`, which wraps every SDK
call in the unified library, so the CLI steps get the same callout (as a `🔷 prism`
banner). Set `PRISM_TRACE=off` to hide them.

The time/level/scope columns stay aligned across every line; the request/response
boundary lines (`[http]`) keep their message flush-left while a request's activity has
its message column indented, so it nests visually. Every line still carries a `reqId` so
you can trace one request end-to-end even if requests interleave. Scopes: `http`,
`store`, `routing`, `orchestrator`, `prism`, `pci`, `control`, `server`. Configure via env:

- `LOG_LEVEL=debug|info|warn|error` (default `debug`)
- `LOG_FORMAT=pretty|json` (default `pretty`; `json` for machine-readable logs, e.g. `LOG_FORMAT=json npm run web | jq`)
- `PRISM_TRACE=off` hides the `[prism]` SDK-boundary callouts (default: on)

Secrets are never logged — card numbers are masked to the last 4 digits, and credential
saves log only the **key names**, never the values.

## Connectors

The registry (`config/psp-registry.ts`) has **Stripe, Adyen, Cybersource** enabled, plus
**GlobalPay** shipped **commented out** as the Step 7 "add a processor" exercise —
un-comment its one registry entry and it joins the others (see the base
[README](../../README.md) step 7). Its browser tokenization (reused verbatim from the
demo store) then works the same as Stripe/Adyen. **Cybersource has no browser (PCI)
integration here** — it works in raw-card mode only; selecting it in PCI mode surfaces a
clear message.

## Credentials

Raw-card mode runs with **no credentials** (you'll see a connector error instead of a
charge). The PCI path needs each connector's sandbox keys. Copy `.env.example` to `.env`
and fill in the ones you want:

| Processor | Server keys | Browser key (PCI) |
|-----------|-------------|-------------------|
| Stripe | `STRIPE_API_KEY` | `STRIPE_PUBLISHABLE_KEY` |
| Adyen | `ADYEN_API_KEY`, `ADYEN_MERCHANT_ACCOUNT` | `ADYEN_CLIENT_KEY` |
| GlobalPay | `GLOBALPAY_APP_ID`, `GLOBALPAY_APP_KEY` | _(same, used for the hosted-fields access token)_ |
| Cybersource | `CYBERSOURCE_API_KEY`, `CYBERSOURCE_MERCHANT_ACCOUNT`, `CYBERSOURCE_API_SECRET` | _(raw only)_ |

## Layout

```
web/
├── server/
│   ├── index.ts            Express app: /store, /control, /api
│   ├── routing-store.ts    declarative rule model + in-memory plan → compiles into selectPsp
│   ├── retry-policy.ts     global retry/fallback on-off (control-plane policy)
│   ├── active-psps.ts      the enabled-processor set (add/remove live)
│   ├── credentials.ts      set a processor's keys at runtime (into process.env)
│   ├── sessions.ts         connector-specific PCI session bootstrap (Stripe/Adyen/GlobalPay)
│   ├── control-state.ts    read/write + watch orchestration-config.json (never secrets)
│   ├── logger.ts           structured, request-correlated logs
│   ├── fetch-diagnostics.ts surfaces the Node-23 undici error before the SDK swallows it
│   ├── products.ts         catalog
│   └── routes/             store.ts, routing.ts, psps.ts, refund.ts
├── orchestration-config.json       tracked control-plane state (plan + enabled set); UI writes it, you can hand-edit it
└── client/
    ├── shared/styles.css
    ├── store/              index.html, checkout.html, js/{app,checkout,stripe-sdk,globalpay-sdk,adyen-sdk}.js
    └── control/            index.html, js/control.js
```

For the whole-repo picture (CLI steps + web) see the **Codebase map** in
[`../README.md`](../README.md#codebase-map).

The connector SDK handlers under `client/store/js/{stripe,globalpay,adyen}-sdk.js` are
reused from the `juspay/hyperswitch-prism` `demo/e-commerce` store.
