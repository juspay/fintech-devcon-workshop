/**
 * Control plane: edit the declarative routing plan the store's Automatic mode uses.
 *
 *   GET  /api/routing            → load plan
 *   PUT  /api/routing            → save plan (validated server-side)
 *   POST /api/routing/simulate   → preview a route
 *   GET  /api/psps               → processor list + status
 *
 * Amounts are edited in MAJOR units (dollars) for readability and converted to the
 * minor units (cents) the routing context uses on save.
 */

const AMOUNT_OPERATORS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
];
const CURRENCY_OPERATORS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
];

let psps = [];
let rules = []; // { id, field, operator, value }  (value: dollars for amount, ISO for currency)
let fallback = 'stripe';
let ruleCounter = 0;

const el = (id) => document.getElementById(id);
const rulesBody = el('rules-body');
const fallbackSelect = el('fallback-select');
const saveStatus = el('save-status');

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadPsps(), loadPlan()]);
  renderPspList();
  renderFallbackOptions();
  renderRules();
  wireEvents();
});

async function loadPsps() {
  const res = await fetch('/api/psps');
  psps = (await res.json()).psps || [];
}

async function loadPlan() {
  const res = await fetch('/api/routing');
  const plan = await res.json();
  fallback = plan.fallback;
  rules = plan.rules.map((r) => ({
    id: r.id || `rule-${ruleCounter++}`,
    field: r.field,
    operator: r.operator,
    value: r.field === 'amount' ? (Number(r.value) / 100).toString() : String(r.value),
    use: r.use,
  }));
}

function wireEvents() {
  el('add-rule-btn').addEventListener('click', addRule);
  el('save-btn').addEventListener('click', savePlan);
  el('revert-btn').addEventListener('click', revert);
  el('sim-btn').addEventListener('click', simulate);
  fallbackSelect.addEventListener('change', () => {
    fallback = fallbackSelect.value === 'none' ? null : fallbackSelect.value;
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────
// Routing can only target ENABLED processors.
function pspOptions(selected) {
  return psps.filter((p) => p.enabled).map((p) =>
    `<option value="${p.name}"${p.name === selected ? ' selected' : ''}>${p.displayName}</option>`).join('');
}

function operatorOptions(field, selected) {
  const ops = field === 'amount' ? AMOUNT_OPERATORS : CURRENCY_OPERATORS;
  return ops.map((o) => `<option value="${o.value}"${o.value === selected ? ' selected' : ''}>${o.label}</option>`).join('');
}

function renderFallbackOptions() {
  // "None" enables a clean slate — an unmatched payment simply has no route.
  const opts = [`<option value="none"${fallback == null ? ' selected' : ''}>None (no fallback)</option>`];
  for (const p of psps.filter((x) => x.enabled)) {
    opts.push(`<option value="${p.name}"${p.name === fallback ? ' selected' : ''}>${p.displayName}</option>`);
  }
  fallbackSelect.innerHTML = opts.join('');
}

function pspItemHtml(p) {
  const inputs = p.envKeys.map((k) => {
    const set = (p.credentials?.find((c) => c.key === k) || {}).set;
    return `<label class="cred-label">${k}
      <input type="password" autocomplete="off" spellcheck="false" data-psp="${p.name}" data-key="${k}"
        placeholder="${set ? '•••••••• set — type to replace' : 'not set'}">
    </label>`;
  }).join('');
  return `
    <li class="psp-item">
      <div class="psp-row">
        <span><strong>${p.displayName}</strong> <span class="mono" style="color:#94a3b8">${p.currencies.join(' · ')}</span></span>
        <span class="psp-badges">
          <span class="badge ${p.tokenizable ? 'badge-pci' : 'badge-raw'}" title="${p.tokenizable ? 'Supports processor-specific tokenization' : 'Processor-agnostic (raw) path only'}">${p.tokenizable ? 'Specific' : 'Agnostic only'}</span>
          <span class="badge ${p.configured ? 'badge-ok' : 'badge-muted'}">${p.configured ? 'configured' : 'no keys'}</span>
          <button class="icon-btn cred-toggle" data-psp="${p.name}" title="Add / update keys">🔑</button>
          <button class="btn btn-secondary btn-sm" data-remove-psp="${p.name}" title="Remove from the orchestrator">Remove</button>
        </span>
      </div>
      <div class="cred-form hidden" id="cred-form-${p.name}">
        ${inputs}
        <div class="cred-actions">
          <button class="btn btn-primary btn-sm" data-save-psp="${p.name}">Save keys</button>
          <button class="btn btn-secondary btn-sm" data-clear-psp="${p.name}">Clear</button>
          <span class="cred-status" id="cred-status-${p.name}"></span>
        </div>
      </div>
    </li>`;
}

function renderPspList() {
  const enabled = psps.filter((p) => p.enabled);
  const disabled = psps.filter((p) => !p.enabled);

  el('psp-list').innerHTML = enabled.map(pspItemHtml).join('');
  el('psp-list').querySelectorAll('.cred-toggle').forEach((btn) =>
    btn.addEventListener('click', () => el(`cred-form-${btn.dataset.psp}`).classList.toggle('hidden')));
  el('psp-list').querySelectorAll('[data-save-psp]').forEach((btn) =>
    btn.addEventListener('click', () => saveCredentials(btn.dataset.savePsp)));
  el('psp-list').querySelectorAll('[data-clear-psp]').forEach((btn) =>
    btn.addEventListener('click', () => clearCredentials(btn.dataset.clearPsp)));
  el('psp-list').querySelectorAll('[data-remove-psp]').forEach((btn) =>
    btn.addEventListener('click', () => toggleProcessor(btn.dataset.removePsp, false)));

  const addArea = el('add-psp-area');
  if (disabled.length === 0) {
    addArea.classList.add('hidden');
    el('add-psp-list').innerHTML = '';
  } else {
    addArea.classList.remove('hidden');
    el('add-psp-list').innerHTML = disabled.map((p) => `
      <div class="add-psp-item">
        <span><strong>${p.displayName}</strong>
          <span class="badge ${p.configured ? 'badge-ok' : 'badge-muted'}">${p.configured ? 'configured' : 'no keys'}</span></span>
        <button class="btn btn-primary btn-sm" data-add-psp="${p.name}">+ Add</button>
      </div>`).join('');
    el('add-psp-list').querySelectorAll('[data-add-psp]').forEach((btn) =>
      btn.addEventListener('click', () => toggleProcessor(btn.dataset.addPsp, true)));
  }
}

// ── Enable / disable a processor (add / remove) ──────────────────────────────
async function toggleProcessor(name, enable) {
  try {
    const res = await fetch(`/api/psps/${name}/${enable ? 'enable' : 'disable'}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update processor');
    await loadPsps();
    renderPspList();
    renderFallbackOptions();
    renderRules();
    setProcStatus(`${data.displayName} ${enable ? 'added' : 'removed'}.`, true);
  } catch (e) {
    setProcStatus(e.message, false);
  }
}

function setProcStatus(msg, ok) {
  const s = el('psp-status');
  if (s) { s.textContent = msg; s.className = `save-status ${ok ? 'ok' : 'err'}`; }
}

// ── Runtime processor credentials (layer in a processor) ─────────────────────
async function saveCredentials(name) {
  const values = {};
  el('psp-list').querySelectorAll(`input[data-psp="${name}"]`).forEach((i) => {
    if (i.value.trim()) values[i.dataset.key] = i.value.trim();
  });
  if (Object.keys(values).length === 0) return setCredStatus(name, 'Enter at least one key.', false);
  await putCredentials(name, values, '✓ Saved — processor is live.');
}

async function clearCredentials(name) {
  const p = psps.find((x) => x.name === name);
  const values = {};
  (p?.envKeys || []).forEach((k) => { values[k] = ''; });
  await putCredentials(name, values, 'Cleared.');
}

async function putCredentials(name, values, okMsg) {
  try {
    const res = await fetch(`/api/psps/${name}/credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    const idx = psps.findIndex((x) => x.name === name);
    if (idx >= 0) psps[idx] = { ...psps[idx], configured: data.configured, credentials: data.credentials };
    renderPspList();
    el(`cred-form-${name}`).classList.remove('hidden'); // keep the panel open
    setCredStatus(name, okMsg, true);
  } catch (e) {
    setCredStatus(name, e.message, false);
  }
}

function setCredStatus(name, msg, ok) {
  const s = el(`cred-status-${name}`);
  if (s) { s.textContent = msg; s.className = `cred-status ${ok ? 'ok' : 'err'}`; }
}

function renderRules() {
  if (rules.length === 0) {
    const emptyMsg = fallback == null
      ? 'No rules and no fallback — Automatic routing has nowhere to go. Add a rule or set a fallback.'
      : 'No rules — every payment goes to the fallback.';
    rulesBody.innerHTML = `<tr><td colspan="7" style="color:#94a3b8;padding:14px 8px">${emptyMsg}</td></tr>`;
    return;
  }
  rulesBody.innerHTML = rules.map((r, i) => {
    const isAmount = r.field === 'amount';
    const valueInput = isAmount
      ? `<input type="number" step="0.01" min="0" data-k="value" value="${escapeAttr(r.value)}" placeholder="50.00">`
      : `<input type="text" data-k="value" value="${escapeAttr(r.value)}" placeholder="EUR" style="text-transform:uppercase">`;
    return `
      <tr data-id="${r.id}">
        <td class="rule-order">${i + 1}</td>
        <td>
          <select data-k="field">
            <option value="amount"${isAmount ? ' selected' : ''}>Amount</option>
            <option value="currency"${!isAmount ? ' selected' : ''}>Currency</option>
          </select>
        </td>
        <td><select data-k="operator">${operatorOptions(r.field, r.operator)}</select></td>
        <td>${valueInput}</td>
        <td style="text-align:center;color:#94a3b8">→</td>
        <td><select data-k="use">${pspOptions(r.use)}</select></td>
        <td>
          <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="icon-btn" data-act="down" ${i === rules.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="icon-btn" data-act="del" title="Delete">✕</button>
        </td>
      </tr>`;
  }).join('');

  // Wire per-row controls
  rulesBody.querySelectorAll('tr[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-k]').forEach((input) => {
      input.addEventListener('change', () => onRowChange(id, input.dataset.k, input.value));
    });
    row.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onRowAction(id, btn.dataset.act));
    });
  });
}

// Preserve the `use` field on the in-memory rule objects (it's read from the row on save,
// but we also mirror it so re-renders keep the selection).
function currentRule(id) {
  return rules.find((r) => r.id === id);
}

function onRowChange(id, key, value) {
  const rule = currentRule(id);
  if (!rule) return;
  if (key === 'field') {
    rule.field = value;
    // Reset operator to a valid one for the new field and re-render that row's controls.
    rule.operator = value === 'amount' ? 'gt' : 'eq';
    if (value === 'currency') rule.value = (rule.value || '').toString().toUpperCase();
    renderRules();
    return;
  }
  rule[key] = value;
}

function onRowAction(id, act) {
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return;
  if (act === 'del') rules.splice(i, 1);
  else if (act === 'up' && i > 0) [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
  else if (act === 'down' && i < rules.length - 1) [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
  renderRules();
}

function addRule() {
  rules.push({ id: `rule-${ruleCounter++}`, field: 'amount', operator: 'gt', value: '50', use: (psps.find((p) => p.enabled) || {}).name || 'stripe' });
  renderRules();
}

// ── Save / revert / simulate ─────────────────────────────────────────────────
// Read the DOM to capture any in-flight edits (selects/inputs) before serializing.
function readRowsFromDom() {
  const out = [];
  rulesBody.querySelectorAll('tr[data-id]').forEach((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`)?.value;
    const field = get('field');
    const rawValue = get('value');
    out.push({
      id: row.dataset.id,
      field,
      operator: get('operator'),
      value: field === 'amount' ? Math.round(parseFloat(rawValue || '0') * 100) : String(rawValue || '').toUpperCase(),
      use: get('use'),
    });
  });
  return out;
}

async function savePlan() {
  const plan = { rules: readRowsFromDom(), fallback: fallbackSelect.value === 'none' ? null : fallbackSelect.value };
  try {
    const res = await fetch('/api/routing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    setStatus('✓ Saved — the store’s Automatic mode now uses this plan.', true);
    // Re-sync from server (normalizes values, ids).
    await loadPlan();
    renderFallbackOptions();
    renderRules();
  } catch (e) {
    setStatus(`✕ ${e.message}`, false);
  }
}

async function revert() {
  await loadPlan();
  renderFallbackOptions();
  renderRules();
  setStatus('Reverted to the saved plan.', true);
}

async function simulate() {
  const dollars = parseFloat(el('sim-amount').value || '0');
  const minorAmount = Math.round(dollars * 100);
  const currency = el('sim-currency').value;
  const box = el('sim-result');
  try {
    const res = await fetch('/api/routing/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minorAmount, currency }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Simulation failed');
    const psp = psps.find((p) => p.name === data.psp);
    const label = data.psp ? (psp ? psp.displayName : data.psp) : 'No route';
    box.innerHTML = `Routed to <strong>${label}</strong><br>
      <span class="mono" style="color:#64748b">${escapeHtml(data.reason)}</span>`;
    box.classList.remove('hidden');
  } catch (e) {
    box.innerHTML = `<span style="color:#991b1b">${escapeHtml(e.message)}</span>`;
    box.classList.remove('hidden');
  }
}

function setStatus(msg, ok) {
  saveStatus.textContent = msg;
  saveStatus.className = `save-status ${ok ? 'ok' : 'err'}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}
