// undici compatibility shim — lets the workshop run on Node 23+ (not just 18–22).
// ─────────────────────────────────────────────────────────────────────────────
// The hyperswitch-prism SDK builds an HTTP dispatcher from its bundled **undici@6**
// and hands it to the **global** `fetch()` (see the SDK's dist/src/http_client.js:
// `fetch(url, { …, dispatcher })`). That only works when the runtime's built-in
// fetch is ALSO undici 6 — i.e. Node 18/20/22. Node 23+ bundles undici 7, whose
// Dispatcher handler interface changed, so the v6 dispatcher is rejected with
// `UND_ERR_INVALID_ARG: invalid onError method` and every connector call fails as
// "Network Error: fetch failed".
//
// Fix: when the runtime's built-in undici is NOT v6, replace the global fetch (and
// its companions) with undici@6's own — the same major the SDK's dispatcher targets
// — so the two line up again. Node's built-in undici is simply bypassed for these
// calls. This is a SIDE-EFFECT module: it must run before the first payment call, so
// `unified-payments.ts` imports it as its very first import. It is a NO-OP on Node
// 18–22 (built-in undici already v6).
//
// Long-term this belongs upstream (the SDK should call its own `undici.fetch`, or
// support undici 7). When it does, delete this file and its single import.
// ─────────────────────────────────────────────────────────────────────────────

import * as undici from 'undici';

const builtinUndiciMajor = Number((process.versions.undici ?? '').split('.')[0]);

if (builtinUndiciMajor !== 6) {
  // Built-in fetch is undici 7+ (or absent) — swap in undici@6's fetch stack so it
  // matches the SDK's v6 dispatcher. Keep Headers/Request/Response/FormData from the
  // same undici so instances passed between them stay compatible.
  const g = globalThis as unknown as Record<string, unknown>;
  g.fetch = undici.fetch;
  g.Headers = undici.Headers;
  g.Request = undici.Request;
  g.Response = undici.Response;
  if (undici.FormData) g.FormData = undici.FormData;

  if (process.env.PRISM_TRACE !== 'off') {
    console.error(
      `[undici-compat] Node ${process.versions.node} bundles undici ${process.versions.undici}; ` +
        `patched global fetch to undici@6 for hyperswitch-prism SDK compatibility.`,
    );
  }
}
