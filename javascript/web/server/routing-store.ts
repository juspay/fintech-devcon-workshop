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
// process), seeded from the workshop's DEFAULT_ROUTING_PLAN. It resets on restart.
// ─────────────────────────────────────────────────────────────────────────────

import {
  selectPsp,
  type RoutingPlan,
  type RoutingRule,
  type RoutingContext,
  type RoutingDecision,
} from '../../src/orchestrator/routing.js';
import { type PspName } from '../../config/psp-registry.js';
import { listActive } from './active-psps.js';

export type ConditionField = 'amount' | 'currency';
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

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
  fallback: PspName;
}

const OP_SYMBOL: Record<ConditionOperator, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
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
    }
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
  const val =
    rule.field === 'amount'
      ? `${(Number(rule.value) / 100).toFixed(2)}`
      : String(rule.value).toUpperCase();
  return `${rule.field} ${OP_SYMBOL[rule.operator]} ${val} → ${rule.use}`;
}

// Compile the declarative plan into the workshop's RoutingPlan so selectPsp() can
// run it unchanged.
export function compilePlan(plan: DeclarativePlan): RoutingPlan {
  const rules: RoutingRule[] = plan.rules.map((r) => ({
    reason: ruleReason(r),
    use: r.use,
    when: (ctx: RoutingContext) => evalRule(r, ctx),
  }));
  return { rules, fallback: plan.fallback };
}

// ── In-memory plan state (seeded to match DEFAULT_ROUTING_PLAN) ──────────────
let currentPlan: DeclarativePlan = {
  rules: [
    { id: 'rule-high-value', field: 'amount', operator: 'gt', value: 5000, use: 'adyen' },
    { id: 'rule-eur', field: 'currency', operator: 'eq', value: 'EUR', use: 'cybersource' },
  ],
  fallback: 'stripe',
};

export function getPlan(): DeclarativePlan {
  return currentPlan;
}

const KNOWN_OPERATORS: ConditionOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

// Validate + persist a plan coming from the control-plane UI. Returns an error
// string on the first problem, or null when the plan is accepted.
export function setPlan(plan: DeclarativePlan): string | null {
  // Routing may only target ENABLED processors (see active-psps).
  const known = new Set(listActive());
  if (!plan || !Array.isArray(plan.rules)) return 'plan.rules must be an array';
  if (!known.has(plan.fallback)) return `fallback PSP "${plan.fallback}" is not an enabled processor`;

  for (const r of plan.rules) {
    if (r.field !== 'amount' && r.field !== 'currency') {
      return `rule ${r.id}: field must be "amount" or "currency"`;
    }
    if (!KNOWN_OPERATORS.includes(r.operator)) {
      return `rule ${r.id}: invalid operator "${r.operator}"`;
    }
    if (r.field === 'currency' && r.operator !== 'eq' && r.operator !== 'neq') {
      return `rule ${r.id}: currency conditions only support "=" or "≠"`;
    }
    if (r.field === 'amount' && Number.isNaN(Number(r.value))) {
      return `rule ${r.id}: amount value must be a number (minor units)`;
    }
    if (!known.has(r.use)) return `rule ${r.id}: PSP "${r.use}" is not an enabled processor`;
  }

  currentPlan = {
    rules: plan.rules.map((r) => ({ ...r })),
    fallback: plan.fallback,
  };
  return null;
}

// Route a payment context through the CURRENT plan (used by the store + simulate).
export function route(ctx: RoutingContext): RoutingDecision {
  return selectPsp(compilePlan(currentPlan), ctx);
}
