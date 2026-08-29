/**
 * Checkout orchestration.
 *
 * Two request-level choices drive everything:
 *   - mode:      'pci' (processor-specific tokenization) | 'raw' (processor-agnostic)
 *   - processor: 'auto' (route by the /control rules) | a specific PSP name
 *
 * RAW  → POST /api/store/checkout            (server authorize + optional retry)
 * PCI  → GET  /api/store/session             (routing resolves here; boots connector SDK)
 *        → connector SDK tokenizes in-browser
 *        → POST /api/store/token-authorize   (unified tokenAuthorize)
 *
 * Both land in the workshop's unified library server-side.
 */

// Per-connector sandbox test cards. In processor-agnostic (raw) mode these fill the
// card form; in processor-specific (PCI) mode they're a reference for the hosted fields.
const TEST_CARDS = {
  stripe: { name: 'Stripe', number: '4242 4242 4242 4242', month: '03', year: '2030', cvc: '737', holder: 'Jane Workshop' },
  adyen: { name: 'Adyen', number: '4111 1111 4555 1142', month: '03', year: '2030', cvc: '737', holder: 'Jane Workshop' },
  cybersource: { name: 'Cybersource', number: '4111 1111 1111 1111', month: '03', year: '2030', cvc: '737', holder: 'Jane Workshop' },
  globalpay: { name: 'GlobalPay', number: '4263 9700 0000 5262', month: '03', year: '2030', cvc: '737', holder: 'Jane Workshop' },
};
const DECLINED_CARD = { name: 'Declined (any)', number: '4000 0000 0000 0002', month: '03', year: '2030', cvc: '737', holder: 'Jane Workshop' };

// State
let checkoutData = null;
let psps = [];
let mode = 'pci';
let processor = 'auto';
let pciSession = null;
let x402Challenge = null; // the 402 requirements from step ①, until settled in step ②

// DOM
const el = (id) => document.getElementById(id);
const orderItemsEl = el('order-items');
const orderTotalEl = el('order-total-amount');
const modeToggle = el('mode-toggle');
const processorSelect = el('processor-select');
const modeNote = el('mode-note');
const connectorInfo = el('payment-connector-info');
const loadingEl = el('loading');
const rawContainer = el('raw-checkout-container');
const rawForm = el('raw-card-form');
const rawSubmitBtn = el('raw-submit-btn');
const x402RequestBtn = el('x402-request-btn');
const x402RequestText = el('x402-request-text');
const x402RequestSpinner = el('x402-request-spinner');
const x402Terms = el('x402-terms');
const pciInitContainer = el('pci-init-container');
const pciInitBtn = el('pci-init-btn');
const stripeContainer = el('stripe-checkout-container');
const globalpayContainer = el('globalpay-checkout-container');
const adyenContainer = el('adyen-checkout-container');
const sampleCards = el('sample-cards');
const sampleCardsList = el('sample-cards-list');
const sampleCardsHint = el('sample-cards-hint');
const paymentResult = el('payment-result');
const resultTrace = el('result-trace');
// Card form fields
const cf = {
  number: el('cf-number'),
  month: el('cf-month'),
  year: el('cf-year'),
  cvc: el('cf-cvc'),
  name: el('cf-name'),
};

document.addEventListener('DOMContentLoaded', async () => {
  loadCheckoutData();
  renderOrderSummary();
  await loadPsps();
  setupConfigUI();
  applyModeUI();
});

function loadCheckoutData() {
  const data = localStorage.getItem('checkoutData');
  if (!data) {
    window.location.href = '/store';
    return;
  }
  checkoutData = JSON.parse(data);
}

function renderOrderSummary() {
  if (!checkoutData) return;
  const { items, currency, totalAmount } = checkoutData;
  orderItemsEl.innerHTML = items.map((item) => {
    const price = currency === 'EUR' ? item.product.priceEUR : item.product.priceUSD;
    return `
      <div class="order-item">
        <div class="order-item-image">${escapeHtml(item.product.image)}</div>
        <div class="order-item-info">
          <div class="order-item-name">${escapeHtml(item.product.name)}</div>
          <div class="order-item-qty">Qty: ${escapeHtml(item.quantity)}</div>
        </div>
        <div class="order-item-price">${formatPrice(price * item.quantity, currency)}</div>
      </div>`;
  }).join('');
  orderTotalEl.textContent = formatPrice(totalAmount, currency);
  el('raw-btn-text').textContent = `② Authorize & pay ${formatPrice(totalAmount, currency)} (X-PAYMENT)`;
}

async function loadPsps() {
  try {
    const res = await fetch('/api/psps');
    const data = await res.json();
    // The store only offers ENABLED processors (managed from the control plane).
    psps = (data.psps || []).filter((p) => p.enabled !== false);
  } catch (e) {
    console.error('[Checkout] Failed to load PSPs:', e);
  }
}

// ── Request-config UI ────────────────────────────────────────────────────────
function setupConfigUI() {
  modeToggle.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      modeToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      applyModeUI();
    });
  });
  // (1) Switching the processor always re-renders the payment UI (tears down any
  // mounted connector SDK / stale session and refreshes the sample cards).
  processorSelect.addEventListener('change', onProcessorChange);

  x402RequestBtn.addEventListener('click', requestTerms);
  rawSubmitBtn.addEventListener('click', submitPayment);
  // Enter in the card form settles if terms are in hand, else fetches them first.
  rawForm.addEventListener('submit', (e) => { e.preventDefault(); x402Challenge ? submitPayment() : requestTerms(); });
  pciInitBtn.addEventListener('click', initPci);
  el('stripe-submit-btn').addEventListener('click', onStripeSubmit);

  // "Use" buttons on the sample cards fill the card form (event-delegated).
  sampleCardsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.use-card-btn');
    if (btn) fillCardForm(btn.dataset, btn);
  });
}

function onProcessorChange() {
  processor = processorSelect.value;
  resetPaymentUI();
  updateModeNote();
}

// Rebuild processor options (disabling non-tokenizable ones in PCI mode).
function renderProcessorOptions() {
  const opts = ['<option value="auto">⚙️ Automatic — route by condition</option>'];
  for (const p of psps) {
    const disabled = mode === 'pci' && !p.tokenizable ? ' disabled' : '';
    const tag = p.tokenizable ? '' : mode === 'pci' ? ' (agnostic only)' : '';
    opts.push(`<option value="${p.name}"${disabled}>${p.displayName}${tag}</option>`);
  }
  processorSelect.innerHTML = opts.join('');
  const stillValid = [...processorSelect.options].some((o) => o.value === processor && !o.disabled);
  processor = stillValid ? processor : 'auto';
  processorSelect.value = processor;
}

function applyModeUI() {
  renderProcessorOptions();
  resetPaymentUI();
  updateModeNote();
}

// Reset the payment surfaces to their initial (pre-payment) state for the current
// mode + processor. Called on mode change AND processor change.
function resetPaymentUI() {
  hideAllPaymentSurfaces();
  hideResult();
  connectorInfo.classList.add('hidden');
  loadingEl.classList.add('hidden');
  pciSession = null;
  const isRaw = mode === 'raw';
  rawContainer.classList.toggle('hidden', !isRaw);
  pciInitContainer.classList.toggle('hidden', isRaw);
  pciInitBtn.disabled = false;
  resetX402(); // a fresh 402 handshake per mode/processor selection
  renderSampleCards();
}

function updateModeNote() {
  let msg = '';
  if (mode === 'pci') {
    const p = psps.find((x) => x.name === processor);
    if (processor === 'auto') {
      msg = 'Routing runs when you initialize payment. If it selects a processor with no ' +
        'processor-specific tokenization (e.g. Cybersource), you’ll be asked to switch to ' +
        'processor-agnostic mode.';
    } else if (p && !p.tokenizable) {
      msg = `${p.displayName} has no processor-specific tokenization in this demo — use processor-agnostic mode for it.`;
    }
  } else if (processor === 'auto') {
    msg = 'Automatic routing. Retry / fallback (try the next processor if one declines) is configured in the control plane.';
  }
  modeNote.textContent = msg;
  modeNote.classList.toggle('hidden', !msg);
}

// ── Sample test cards (left column) ──────────────────────────────────────────
function renderSampleCards() {
  let cards = [];
  let hint = '';
  const fillable = mode === 'raw';

  if (mode === 'raw') {
    if (processor === 'auto') {
      // (3) Routing is unknown, so show every processor's card + a declined one.
      cards = psps.map((p) => TEST_CARDS[p.name]).filter(Boolean);
      cards.push(DECLINED_CARD);
      hint = 'Automatic routing — use the card for whichever processor it picks.';
    } else {
      const c = TEST_CARDS[processor];
      cards = c ? [c, DECLINED_CARD] : [DECLINED_CARD];
      hint = `For ${describePsp(processor)}.`;
    }
  } else {
    // PCI: the routed/selected connector's card (reference for the hosted fields).
    const conn = pciSession?.connector || (processor !== 'auto' ? processor : null);
    if (conn && TEST_CARDS[conn]) {
      cards = [TEST_CARDS[conn]];
      hint = `Type this into the ${describePsp(conn)} form.`;
    } else {
      sampleCards.classList.add('hidden');
      return;
    }
  }

  sampleCardsHint.textContent = hint;
  sampleCardsList.innerHTML = cards.map((c) => sampleCardHtml(c, fillable)).join('');
  sampleCards.classList.remove('hidden');
}

function sampleCardHtml(c, fillable) {
  const useBtn = fillable
    ? `<button type="button" class="use-card-btn" data-number="${escapeAttr(c.number)}" ` +
      `data-month="${c.month}" data-year="${c.year}" data-cvc="${c.cvc}" data-name="${escapeAttr(c.holder)}">Use →</button>`
    : '';
  return `
    <div class="sample-card">
      <div class="sample-card-head">
        <span class="sample-card-name">${escapeHtml(c.name)}</span>
        ${useBtn}
      </div>
      <div class="sample-card-num">${escapeHtml(c.number)}</div>
      <div class="sample-card-meta">Exp ${c.month}/${c.year} · CVC ${c.cvc}</div>
    </div>`;
}

function fillCardForm(ds, btn) {
  cf.number.value = ds.number;
  cf.month.value = ds.month;
  cf.year.value = ds.year;
  cf.cvc.value = ds.cvc;
  cf.name.value = ds.name;
  el('raw-error').textContent = '';
  if (btn) {
    const original = btn.textContent;
    btn.textContent = '✓ Filled';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1200);
  }
}

// ── Processor-agnostic (raw) payment ─────────────────────────────────────────
function readCardForm() {
  return {
    cardNumber: cf.number.value.replace(/\s/g, ''),
    cardExpMonth: cf.month.value.trim().padStart(2, '0'),
    cardExpYear: normalizeYear(cf.year.value.trim()),
    cardCvc: cf.cvc.value.trim(),
    cardHolderName: cf.name.value.trim() || 'Card Holder',
  };
}

function normalizeYear(y) {
  return /^\d{2}$/.test(y) ? `20${y}` : y;
}

function validateCard(c) {
  if (!/^\d{12,19}$/.test(c.cardNumber)) return 'Enter a valid card number (digits only).';
  const m = parseInt(c.cardExpMonth, 10);
  if (!(m >= 1 && m <= 12)) return 'Enter a valid expiry month (01–12).';
  if (!/^\d{4}$/.test(c.cardExpYear)) return 'Enter a valid expiry year (YYYY).';
  if (!/^\d{3,4}$/.test(c.cardCvc)) return 'Enter a valid CVC (3–4 digits).';
  return null;
}

// UTF-8-safe base64 for the X-PAYMENT header payload.
function b64(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((byte) => { bin += String.fromCharCode(byte); });
  return btoa(bin);
}

// Processor-agnostic pay uses an x402-INSPIRED handshake (a custom `card` scheme —
// NOT on-chain x402; see web/server/x402.ts), split into two explicit user steps:
//   ① requestTerms(): POST /checkout with no card → server replies 402 + `accepts`.
//   ② submitPayment(): resubmit with an X-PAYMENT header carrying the card → settle.

// ① Fetch the payment terms. Deliberately requires NO card details.
async function requestTerms() {
  el('raw-error').textContent = '';
  setX402RequestLoading(true);
  hideResult();
  try {
    const challenge = await fetch('/api/store/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minorAmount: checkoutData.totalAmount,
        currency: checkoutData.currency,
        processor,
      }),
    });
    if (challenge.status !== 402) {
      const d = await challenge.json().catch(() => ({}));
      throw new Error(d.error || `Expected 402 Payment Required, got HTTP ${challenge.status}`);
    }
    x402Challenge = await challenge.json();
    renderX402Terms(x402Challenge);
    rawSubmitBtn.disabled = false;         // step ② is now available
    x402RequestText.textContent = '✓ Terms received — re-request';
  } catch (e) {
    showError(e.message);
  } finally {
    setX402RequestLoading(false);
  }
}

// ② Provide the card and submit the X-PAYMENT envelope to settle.
async function submitPayment() {
  if (!x402Challenge) { el('raw-error').textContent = 'Request payment terms first (step ①).'; return; }
  const card = readCardForm();
  const err = validateCard(card);
  if (err) { el('raw-error').textContent = err; return; }
  el('raw-error').textContent = '';

  setRawLoading(true);
  hideResult();
  try {
    // Retry/fallback is a control-plane policy (see /control), applied server-side.
    const payment = {
      x402Version: x402Challenge.x402Version,
      scheme: 'card',
      minorAmount: checkoutData.totalAmount,
      currency: checkoutData.currency,
      processor,
      card,
    };
    const settle = await fetch('/api/store/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': b64(payment) },
      body: JSON.stringify({}),
    });
    const data = await settle.json();
    if (!settle.ok) throw new Error(data.error || 'Checkout failed');
    data._x402 = {
      accepts: (x402Challenge.accepts && x402Challenge.accepts[0]) || null,
      response: settle.headers.get('X-PAYMENT-RESPONSE') || '',
    };
    setRawLoading(false);
    renderRawResult(data);
    resetX402(); // consumed — a fresh 402 is required for another attempt
  } catch (e) {
    setRawLoading(false);
    showError(e.message);
  }
}

// Render the 402 terms between the two steps.
function renderX402Terms(req) {
  const a = req.accepts && req.accepts[0];
  const procs = a ? a.processors.join(', ') : '';
  x402Terms.innerHTML = `
    <div class="x402-terms-head"><span class="badge badge-muted">402 Payment Required</span>
      <span class="mono" style="color:#94a3b8">x402-inspired · not on-chain</span></div>
    <div class="x402-terms-body mono">scheme <strong>${a ? escapeHtml(a.scheme) : '—'}</strong>
      · ${a ? escapeHtml(a.maxAmountRequired) : '—'} ${a ? escapeHtml(a.currency) : ''}
      · accepts: ${escapeHtml(procs)}</div>
    <div class="x402-terms-note">Now provide the card and submit the <span class="mono">X-PAYMENT</span> to settle ↓</div>`;
  x402Terms.classList.remove('hidden');
}

// Clear the handshake state so the next attempt starts from a fresh 402.
function resetX402() {
  x402Challenge = null;
  if (x402Terms) { x402Terms.classList.add('hidden'); x402Terms.innerHTML = ''; }
  if (rawSubmitBtn) rawSubmitBtn.disabled = true;
  if (x402RequestText) x402RequestText.textContent = '① Request payment terms (402)';
}

function setX402RequestLoading(on) {
  x402RequestBtn.disabled = on;
  x402RequestText.classList.toggle('hidden', on);
  x402RequestSpinner.classList.toggle('hidden', !on);
}

// Render the x402-inspired handshake steps for the result trace.
function x402HandshakeHtml(x) {
  if (!x) return '';
  const procs = x.accepts ? x.accepts.processors.join(', ') : '';
  let receipt = '';
  try { if (x.response) receipt = JSON.stringify(JSON.parse(atob(x.response))); } catch { /* ignore */ }
  return `
    <div class="trace-summary" style="margin-bottom:10px">
      <div><span class="badge badge-muted">x402-inspired handshake</span>
        <span class="mono" style="color:#94a3b8">demo · not on-chain x402</span></div>
      <div class="attempt-detail" style="margin-top:6px;line-height:1.7">
        ① <span class="mono">POST /checkout</span> → <strong>402 Payment Required</strong>${procs ? ` · accepts: <span class="mono">${escapeHtml(procs)}</span>` : ''}<br>
        ② resubmit with <span class="mono">X-PAYMENT</span> (scheme=<span class="mono">card</span>) → <strong>200 OK</strong>${receipt ? `<br>③ <span class="mono">X-PAYMENT-RESPONSE</span> ${escapeHtml(receipt)}` : ''}
      </div>
    </div>`;
}

function renderRawResult(data) {
  const routed = psps.find((p) => p.name === data.routedTo);
  const summary = `
    <div class="trace-summary">
      <div><span class="badge badge-raw">Processor-agnostic</span>
        ${data.automatic ? '<span class="badge badge-muted">Automatic routing</span>' : '<span class="badge badge-muted">Manual</span>'}
        ${data.retryEnabled ? '<span class="badge badge-muted">Retry on</span>' : ''}</div>
      <div style="margin-top:8px"><strong>Routed to:</strong> ${routed ? routed.displayName : data.routedTo}
        &nbsp;—&nbsp;<span class="mono">${escapeHtml(data.reason)}</span></div>
    </div>`;
  const attempts = data.attempts.map((a, i) => `
    <div class="attempt-row">
      <div>
        <span class="rule-order">#${i + 1}</span>
        <span class="attempt-psp">${a.displayName}</span>
        <div class="attempt-detail">${a.statusText} (${a.status})${a.error ? ` — ${escapeHtml(a.error)}` : ''}${a.transactionId ? ` · ${a.transactionId}` : ''}</div>
      </div>
      <span class="badge ${a.ok ? 'badge-ok' : 'badge-fail'}">${a.ok ? 'approved' : 'declined'}</span>
    </div>`).join('');

  showResult(data.succeeded,
    data.succeeded ? 'Payment Successful!' : 'Payment Not Completed',
    data.succeeded ? `Charged via ${describePsp(data.winningPsp)}.` : 'No processor approved this payment.',
    x402HandshakeHtml(data._x402) + summary + attempts);
  if (data.succeeded) clearPurchasedItems();
}

// ── Processor-specific (PCI) payment ─────────────────────────────────────────
async function initPci() {
  pciInitBtn.disabled = true;
  loadingEl.classList.remove('hidden');
  hideResult();
  try {
    const url = `/api/store/session?amount=${checkoutData.totalAmount}&currency=${checkoutData.currency}&processor=${processor}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to initialize payment');

    pciSession = data;
    connectorInfo.innerHTML = `<span class="badge badge-pci">Processor-specific</span>
      &nbsp;<strong>Processor:</strong> ${describePsp(data.connector)}
      ${data.automatic ? `<br><small class="mono">${escapeHtml(data.reason)}</small>` : ''}`;
    connectorInfo.classList.remove('hidden');
    pciInitContainer.classList.add('hidden');
    renderSampleCards(); // now shows the routed connector's reference card

    if (data.connector === 'stripe') await mountStripe();
    else if (data.connector === 'globalpay') await mountGlobalPay();
    else if (data.connector === 'adyen') await mountAdyen();
  } catch (e) {
    showError(e.message);
    pciInitContainer.classList.remove('hidden');
  } finally {
    pciInitBtn.disabled = false;
    loadingEl.classList.add('hidden');
  }
}

async function mountStripe() {
  stripeContainer.classList.remove('hidden');
  await initStripe(pciSession.publishableKey, pciSession.clientToken);
}

async function onStripeSubmit(e) {
  e.preventDefault();
  const result = await submitStripePayment();
  if (result.success) await tokenAuthorize(result.paymentMethod.id, 'stripe');
}

async function mountGlobalPay() {
  globalpayContainer.classList.remove('hidden');
  await initGlobalPay(pciSession.clientToken);
  setupGlobalPayHandlers(async (token) => tokenAuthorize(token, 'globalpay'));
}

async function mountAdyen() {
  adyenContainer.classList.remove('hidden');
  const session = { id: pciSession.clientToken, sessionData: pciSession.sessionData?.sessionData || '' };
  const countryCode = checkoutData.currency === 'EUR' ? 'NL' : 'US';
  await initAdyen(session, pciSession.publishableKey, {
    amount: checkoutData.totalAmount,
    currency: checkoutData.currency,
    countryCode,
    locale: 'en-US',
  });
  loadingEl.classList.add('hidden');
  // Adyen Sessions Flow authorizes client-side; no server token-authorize call.
  const result = await waitForPaymentCompletion();
  if (result.success) {
    const txn = result.result?.pspReference || result.result?.merchantReference || 'adyen-payment';
    showResult(true, 'Payment Successful!', 'Charged via Adyen (Sessions Flow).', pciSummary('adyen', txn, true));
    clearPurchasedItems();
  } else {
    showResult(false, 'Payment Not Completed', result.error || 'Payment failed', pciSummary('adyen', null, false));
  }
}

// Finalize a tokenized payment through the unified library.
async function tokenAuthorize(token, connector) {
  try {
    const res = await fetch('/api/store/token-authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        merchantTransactionId: pciSession.merchantTransactionId,
        amount: checkoutData.totalAmount,
        currency: checkoutData.currency,
        connector,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Authorization failed');
    showResult(data.succeeded,
      data.succeeded ? 'Payment Successful!' : 'Payment Not Completed',
      data.succeeded ? `Charged via ${describePsp(connector)}.` : (data.error || `Payment ${data.statusText}`),
      pciSummary(connector, data.transactionId, data.succeeded, data.statusText, data.status));
    if (data.succeeded) clearPurchasedItems();
  } catch (e) {
    showError(e.message);
  }
}

function pciSummary(connector, txn, ok, statusText, status) {
  const detail = statusText ? `${statusText}${status != null ? ` (${status})` : ''}` : (ok ? 'CHARGED' : 'FAILED');
  return `
    <div class="trace-summary">
      <div><span class="badge badge-pci">Processor-specific</span>
        <span class="badge badge-muted">${processor === 'auto' ? 'Automatic routing' : 'Manual'}</span></div>
      <div style="margin-top:8px"><strong>Processor:</strong> ${describePsp(connector)}</div>
    </div>
    <div class="attempt-row">
      <div><span class="attempt-psp">${describePsp(connector)}</span>
        <div class="attempt-detail">${detail}${txn ? ` · ${txn}` : ''}</div></div>
      <span class="badge ${ok ? 'badge-ok' : 'badge-fail'}">${ok ? 'approved' : 'declined'}</span>
    </div>`;
}

// ── Result + shared helpers ──────────────────────────────────────────────────
function showResult(success, title, message, traceHtml) {
  hideAllPaymentSurfaces();
  connectorInfo.classList.add('hidden');
  paymentResult.classList.remove('hidden');
  el('result-icon').textContent = success ? '✅' : '❌';
  el('result-title').textContent = title;
  el('result-message').textContent = message;
  el('result-txn-id').textContent = '';
  resultTrace.innerHTML = traceHtml || '';
}

function showError(message) {
  loadingEl.classList.add('hidden');
  paymentResult.classList.remove('hidden');
  el('result-icon').textContent = '❌';
  el('result-title').textContent = 'Something went wrong';
  el('result-message').textContent = message;
  el('result-txn-id').textContent = '';
  resultTrace.innerHTML = '';
}

function hideResult() {
  paymentResult.classList.add('hidden');
}

function hideAllPaymentSurfaces() {
  stripeContainer.classList.add('hidden');
  globalpayContainer.classList.add('hidden');
  adyenContainer.classList.add('hidden');
}

function setRawLoading(on) {
  rawSubmitBtn.disabled = on;
  el('raw-btn-spinner').classList.toggle('hidden', !on);
}

function describePsp(name) {
  const p = psps.find((x) => x.name === name);
  return p ? p.displayName : name;
}

function clearPurchasedItems() {
  const saved = localStorage.getItem('cart');
  if (saved) {
    let cart = JSON.parse(saved).filter((item) => item.currency !== checkoutData.currency);
    if (cart.length === 0) localStorage.removeItem('cart');
    else localStorage.setItem('cart', JSON.stringify(cart));
  }
  localStorage.removeItem('checkoutData');
}

function formatPrice(amount, currency) {
  const symbol = currency === 'EUR' ? '€' : '$';
  return `${symbol}${(amount / 100).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}
