// Control-plane routing state
// ─────────────────────────────────────────────────────────────────────────────
// The CLI workshop defines routing rules in CODE: each rule's condition is an
// opaque JS predicate (`when: (ctx) => boolean`) — great for teaching, but not
// something a web UI can edit. This module gives the /control page a DECLARATIVE,
// serializable rule model ({ field, operator, value, use }) and compiles it back
// into the exact `RoutingPlan` shape that the existing `selectPsp()` consumes.
//
// Nothing about the orchestrator changes — we reuse selectPsp() unchanged. We
// just generate its `when` closures from data instead of hand-writing them.
//
// State is in-memory and shared across the store and control routes (same Express
// process). The workshop starts from a CLEAN SLATE — no rules and no fallback — so
// participants build the plan up one rule at a time in /control. Boot restores
// whatever routing-plan.json holds (see control-state.ts). It resets on restart.
// (The CLI's DEFAULT_ROUTING_PLAN in orchestrator/routing.ts is separate and still
// carries the step-6a demo rules.)
// ─────────────────────────────────────────────────────────────────────────────

import {
  selectPsp,
  type RoutingPlan,
  type RoutingRule,
  type RoutingContext,
} from '../../src/orchestrator/routing.js';
import { type PspName } from '../../config/psp-registry.js';
import { listActive } from './active-psps.js';

export type ConditionField = 'amount' | 'currency' | 'card';
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'startsWith';

// A single editable routing rule. For `amount`, `value` is in MINOR units (cents)
// and only the numeric operators apply. For `currency`, `value` is an ISO code and
// only eq/neq apply.
export interface DeclarativeRule {
  id: string;
  field: ConditionField;
  operator: ConditionOperator;
  value: string | number;
  use: PspName;
}

export interface DeclarativePlan {
  rules: DeclarativeRule[];
  // `null` = no fallback: an unmatched payment has no route (a clean slate). The
  // wire value 'none' is also accepted from the UI and normalized to null.
  fallback: PspName | null;
}

// A routing outcome that may have NO processor (empty plan + no fallback).
export interface RouteResult {
  psp: PspName | null;
  reason: string;
}

const OP_SYMBOL: Record<ConditionOperator, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
  startsWith: 'starts with',
};

// ── Evaluate one declarative rule against a payment context ──────────────────
function evalRule(rule: DeclarativeRule, ctx: RoutingContext): boolean {
  if (rule.field === 'amount') {
    const a = ctx.minorAmount;
    const v = Number(rule.value);
    if (Number.isNaN(v)) return false;
    switch (rule.operator) {
      case 'gt':
        return a > v;
      case 'gte':
        return a >= v;
      case 'lt':
        return a < v;
      case 'lte':
        return a <= v;
      case 'eq':
        return a === v;
      case 'neq':
        return a !== v;
      default:
        return false;
    }
  }

  if (rule.field === 'card') {
    // BIN routing: match the card number's prefix. The card is only present in the
    // processor-agnostic (raw) flow; in the tokenized flow ctx.cardNumber is
    // undefined, so card rules simply don't match there.
    const pan = String(ctx.cardNumber ?? '').replace(/\s+/g, '');
    const prefix = String(rule.value).replace(/\s+/g, '');
    return rule.operator === 'startsWith' && prefix.length > 0 && pan.startsWith(prefix);
  }

  // currency
  const c = ctx.currency.toUpperCase();
  const v = String(rule.value).toUpperCase();
  switch (rule.operator) {
    case 'eq':
      return c === v;
    case 'neq':
      return c !== v;
    default:
      return false; // ordering operators are meaningless for a currency code
  }
}

function ruleReason(rule: DeclarativeRule): string {
  if (rule.field === 'amount') {
    return `amount ${OP_SYMBOL[rule.operator]} ${(Number(rule.value) / 100).toFixed(2)} → ${rule.use}`;
  }
  if (rule.field === 'card') {
    return `card starts with ${String(rule.value)} → ${rule.use}`;
  }
  return `currency ${OP_SYMBOL[rule.operator]} ${String(rule.value).toUpperCase()} → ${rule.use}`;
}

function compileRules(rules: DeclarativeRule[]): RoutingRule[] {
  return rules.map((r) => ({
    reason: ruleReason(r),
    use: r.use,
    when: (ctx: RoutingContext) => evalRule(r, ctx),
  }));
}

// Compile a plan that HAS a fallback into the workshop's RoutingPlan so selectPsp()
// can run it unchanged.
export function compilePlan(plan: { rules: DeclarativeRule[]; fallback: PspName }): RoutingPlan {
  return { rules: compileRules(plan.rules), fallback: plan.fallback };
}

// ── In-memory plan state — starts empty (clean slate; build it up in /control) ──
let currentPlan: DeclarativePlan = {
  rules: [],
  fallback: null,
};

export function getPlan(): DeclarativePlan {
  return currentPlan;
}

const KNOWN_OPERATORS: ConditionOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'startsWith'];

// Validate + persist a plan coming from the control-plane UI. Returns an error
// string on the first problem, or null when the plan is accepted.
export function setPlan(plan: DeclarativePlan): string | null {
  // Routing may only target ENABLED processors (see active-psps).
  const known = new Set(listActive());
  if (!plan || !Array.isArray(plan.rules)) return 'plan.rules must be an array';
  // A missing/'none'/null fallback means "no fallback" (clean slate).
  const rawFallback = plan.fallback as PspName | 'none' | null | undefined;
  const fallback: PspName | null = rawFallback == null || rawFallback === 'none' ? null : rawFallback;
  if (fallback !== null && !known.has(fallback)) {
    return `fallback PSP "${fallback}" is not an enabled processor`;
  }

  for (const r of plan.rules) {
    if (r.field !== 'amount' && r.field !== 'currency' && r.field !== 'card') {
      return `rule ${r.id}: field must be "amount", "currency" or "card"`;
    }
    if (!KNOWN_OPERATORS.includes(r.operator)) {
      return `rule ${r.id}: invalid operator "${r.operator}"`;
    }
    if (r.field === 'currency' && r.operator !== 'eq' && r.operator !== 'neq') {
      return `rule ${r.id}: currency conditions only support "=" or "≠"`;
    }
    if (r.field === 'card' && r.operator !== 'startsWith') {
      return `rule ${r.id}: card conditions only support "starts with"`;
    }
    if (r.operator === 'startsWith' && r.field !== 'card') {
      return `rule ${r.id}: "starts with" only applies to card`;
    }
    if (r.field === 'amount' && Number.isNaN(Number(r.value))) {
      return `rule ${r.id}: amount value must be a number (minor units)`;
    }
    if (r.field === 'card' && !/^\d{1,19}$/.test(String(r.value))) {
      return `rule ${r.id}: card prefix must be 1–19 digits`;
    }
    if (!known.has(r.use)) return `rule ${r.id}: PSP "${r.use}" is not an enabled processor`;
  }

  currentPlan = {
    rules: plan.rules.map((r) => ({ ...r })),
    fallback,
  };
  return null;
}

// Route a payment context through the CURRENT plan (used by the store + simulate).
// Reuses selectPsp() when a fallback is set; a null fallback ("none") means an
// unmatched payment has no route.
export function route(ctx: RoutingContext): RouteResult {
  const plan = currentPlan;
  if (plan.fallback !== null) {
    return selectPsp(compilePlan({ rules: plan.rules, fallback: plan.fallback }), ctx);
  }
  for (const rule of compileRules(plan.rules)) {
    if (rule.when(ctx)) return { psp: rule.use, reason: rule.reason };
  }
  return { psp: null, reason: 'no rule matched and no fallback set' };
}
