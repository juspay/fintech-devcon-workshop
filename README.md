# fintech-devcon workshop — Building a Multi-processor Payment Orchestrator

A hands-on workshop for building a multi-processor payment orchestrator.  You'll
accept a payment through one processor, add more, route between them, go processor-agnostic,
retry across processors on failure, following along in a browser (an e-commerce
store + an orchestration control plane) and inspecting exactly what changes at
each step. We will also understand how bullet-proof processor and payment flow
integrations are done.  The workshop leverages the hyperswitch-prism unified payment
library to power the processor integrations.

## Workshop sequence

Follow along in the **web experience** (`npm run web` → **[localhost:3000/store](http://localhost:3000/store)**
and **[/control](http://localhost:3000/control)**). The workshop starts from a **clean
slate** — no processors, no rules, no fallback — and you layer everything in. Each change
you make in the control plane is written to a single git-tracked file,
**`javascript/web/orchestration-config.json`**, so after every step you can run
`git diff` and see precisely what changed.

| # | Step | ~Time | What you do (in the browser) | `git diff .../orchestration-config.json` |
|---|------|-------|------------------------------|------------------------------------------|
| 1 | **Prerequisites & overview** | 10m | `npm install`, `npm test`, `npm run web`; open `/store` + `/control`. The config starts empty. | *(nothing yet — the clean slate)* |
| 2 | **Accept payments with one processor** *(processor-specific tokenization)* | 5m | Add **one** processor (Stripe) in `/control`; pay in `/store` with **Processor-specific tokenization**. | `enabled: []` → `["stripe"]` |
| 3 | **Accept payments with multiple processors** *(processor-specific tokenization)* | 5m | Add **Adyen** and **GlobalPay**; check out selecting each. | `enabled` grows to add `adyen`, `globalpay` |
| 4 | **Routing between processors** *(+ the limits of processor tokenization)* | 10m | Add amount/currency **rules** + a **fallback**; use `/store` **Automatic**. Note: a processor-specific token is **pinned to the connector chosen at session time**, so it can't retry on another processor. | `rules: [ … ]` added, `fallback` set |
| 5 | **Processor-agnostic experience & enhanced routing** | 5m | Switch `/store` to **Processor-agnostic tokenization**. Now the server holds the card, so add a **card-number (BIN) rule** — routing on a *customer* attribute, not just the merchant's amount. | a `card … starts with` rule added |
| 6 | **Retrying failed payments across processors** | 10m | Turn on **Retry / fallback** in `/control`; a declined primary now cascades to the next enabled processor (processor-agnostic only — see step 4). | `retryEnabled: false` → `true` |
| 7 | **Extend to a new processor — GlobalPay** *(walk-through)* | 15m | GlobalPay ships **commented out** in `config/psp-registry.ts`. Un-comment its **one entry** and it appears in `/control`, the store, routing, and retry — then add it (+ its keys) like any other processor. | *(a **code** diff, not the config)* |
| 8 | **Extend to a new flow — refund** *(walk-through)* | — | The refund flow ships **disabled**. Enable it in `src/library/unified-payments.ts` (delete the stub, un-comment `refund()`), then **refund a payment** from the new **Refund** panel in `/control` — through the same prism library. | *(a **code** diff, not the config)* |

> **Tip for clean per-step diffs.** The file accumulates your changes, so `git diff`
> shows everything since the start. To see *just* the current step, stage the file after
> each step — `git add javascript/web/orchestration-config.json` — then the next
> `git diff` shows only what that step changed. `git checkout javascript/web/orchestration-config.json`
> resets to the empty clean slate at any time.

## Start here

```bash
# Clone
git clone https://github.com/juspay/fintech-devcon-workshop.git
cd fintech-devcon-workshop

# Install
cd javascript
npm install
npm test                 # verify setup (no credentials needed)

# Run the web experience, then follow the sequence above
npm run web              # open http://localhost:3000/store and /control
```

**Requirements:** Git and **Node.js 18, 20, or 22 LTS — not 23+** (newer Node bundles
undici 7, which breaks the SDK's `undici@6` HTTP dispatcher and makes every connector call
fail with *"Network Error: fetch failed"*; `.nvmrc` pins Node 22). Linux x64, macOS, or
Windows via WSL2 (the SDK ships a prebuilt native x86_64 library — no Rust toolchain, no
build step; scripts run TypeScript directly via `tsx`).

The **web experience** puts the same unified library and orchestrator behind an
e-commerce storefront (`/store`) and an orchestration **control plane** (`/control`).
The store checkout lets you pick a specific processor or let the system route by
condition, and toggle **processor-specific** (browser-tokenized, PCI) vs
**processor-agnostic** (raw-card) tokenization — both finish through the unified library.
See [`javascript/web/README.md`](./javascript/web/README.md).

Under the hood, every control-plane action is the same core the CLI steps use, made
editable. Two companion docs go deeper — each with a distinct job, so nothing is repeated:

- **[`javascript/CLI-WALKTHROUGH.md`](./javascript/CLI-WALKTHROUGH.md)** — the **pure-CLI
  track**: the same concepts from the terminal (`npm run run:payment | run:routing |
  run:retry | run:extend`), by editing code.
- **[`javascript/README.md`](./javascript/README.md)** — **how the code is built**: the
  layer diagram, codebase map, and request-flow diagram.
- **[`javascript/web/README.md`](./javascript/web/README.md)** — the **web experience
  internals** (store, control plane, refund, logs).

## Other languages

This repo implements the workshop end-to-end in **JavaScript/TypeScript** under
[`javascript/`](./javascript/). Additional language tracks (`python/`,
`kotlin/`) can be added as sibling folders. A natural extension is to repeat the
sequence above in another language.

For the "repeat in another language" portion, the
[**juspay/hyperswitch-prism**](https://github.com/juspay/hyperswitch-prism)
repository's top-level `examples/` directory contains the **same connectors**
(Stripe, Adyen, Cybersource, and 90+ more) implemented in:

- **Python** — `examples/<connector>/<connector>.py`
- **Kotlin/Java** — `examples/<connector>/<connector>.kt`
- **Rust** — `examples/<connector>/<connector>.rs`

The SDKs for those languages live under that repo's `sdk/` (`python`, `java`,
`rust`). The concepts demonstrated here — unified request/response, swapping
PSPs, routing, retry — translate directly; only the syntax changes. A natural
extension of this workshop is to port `javascript/` to Python or Kotlin using
those SDKs.

## No credentials? Still works.

Every demo runs without API keys: the unified library builds and sends the
request, and you'll see a connector error instead of a charge. Add sandbox keys
to `javascript/.env` (copy from `.env.example`) to see real approvals. The test
suite needs **no** credentials.

---

*The hyperswitch-prism SDK is published on npm as
[`hyperswitch-prism`](https://www.npmjs.com/package/hyperswitch-prism) and is
installed automatically by `npm install`.*
