// All monetary source amounts and allocations are integer USD microdollars (1 USD = 1,000,000 micros).
export class ValidationError extends Error {}
const fail = message => { throw new ValidationError(message); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
export function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Expected a JSON object.');
  if (data.schema_version !== 1 || data.currency !== 'USD' || data.synthetic !== true) fail('This prototype accepts schema_version 1, USD, explicitly synthetic data only.');
  if (!Array.isArray(data.periods) || data.periods.length !== 2) fail('Exactly two periods are required, baseline first.');
  const periods = new Set();
  for (const p of data.periods) {
    if (!p || !id(p.id) || periods.has(p.id) || !integer(p.invoice_micros)) fail('Periods need unique IDs and nonnegative integer invoice_micros.');
    periods.add(p.id);
  }
  for (const key of ['usage', 'outcomes', 'billing_lines']) if (!Array.isArray(data[key]) || data[key].length > 5000) fail(`${key} must be an array with at most 5000 records.`);
  const bills = new Map();
  for (const b of data.billing_lines) {
    if (!b || !id(b.id) || bills.has(b.id) || !periods.has(b.period) || !integer(b.cost_micros) || !/^\d{12}$/.test(b.account_id) || !id(b.region) || !id(b.service)) fail('Billing lines need unique IDs, known periods, 12-digit fictional accounts, region, service and integer cost_micros.');
    bills.set(b.id, b);
  }
  for (const p of data.periods) if (data.billing_lines.filter(b => b.period === p.id).reduce((n,b) => n + b.cost_micros, 0) !== p.invoice_micros) fail(`Period ${p.id}: billing lines must sum to invoice_micros.`);
  const outcomes = new Map();
  for (const o of data.outcomes) {
    if (!o || !id(o.id) || outcomes.has(o.id) || !periods.has(o.period) || !id(o.workflow) || !['success', 'failure'].includes(o.status)) fail('Outcomes need unique IDs, known periods, workflow IDs and success/failure status.');
    outcomes.set(o.id, o);
  }
  const seen = new Set();
  for (const r of data.usage) {
    if (!r || !id(r.id) || seen.has(r.id) || !periods.has(r.period) || !id(r.model) || !integer(r.cost_micros) || !integer(r.tokens) || typeof r.shared !== 'boolean') fail('Usage needs unique IDs, known periods/models, integer cost_micros/tokens and a shared boolean.');
    if (r.workflow !== null && !id(r.workflow)) fail(`Usage ${r.id}: workflow must be an ID or null.`);
    if (r.outcome_id !== null && !id(r.outcome_id)) fail(`Usage ${r.id}: outcome_id must be an ID or null.`);
    if (r.shared && (r.workflow !== null || r.outcome_id !== null)) fail(`Shared record ${r.id} cannot have a workflow or outcome.`);
    if (r.outcome_id !== null) {
      const o = outcomes.get(r.outcome_id);
      if (!o || o.period !== r.period || o.workflow !== r.workflow) fail(`Usage ${r.id}: outcome reference must match period and workflow.`);
    }
    const bill = bills.get(r.billing_line_id);
    if (!bill || bill.period !== r.period || bill.account_id !== r.account_id || bill.region !== r.region || bill.service !== r.service) fail(`Usage ${r.id}: billing line reference must match period/account/region/service.`);
    if (!integer(r.input_tokens) || !integer(r.output_tokens) || r.input_tokens + r.output_tokens !== r.tokens) fail(`Usage ${r.id}: input_tokens + output_tokens must equal tokens.`);
    if (!integer(r.attempt) || r.attempt < 1 || !['success', 'failure', 'overhead'].includes(r.invocation_status)) fail(`Usage ${r.id}: invalid attempt or invocation_status.`);
    if (!r.tags || r.tags.workflow !== r.workflow || !id(r.tags.team)) fail(`Usage ${r.id}: allocation tags must match workflow and include team.`);
    seen.add(r.id);
  }
  return data;
}
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
// Largest-remainder allocation conserves every microdollar. BigInt avoids product precision loss.
export function allocate(micros, weights) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0).sort(([a], [b]) => a.localeCompare(b));
  const total = entries.reduce((n, [, weight]) => n + BigInt(weight), 0n);
  if (!total) return {};
  const parts = entries.map(([workflow, weight]) => {
    const product = BigInt(micros) * BigInt(weight);
    return {workflow, micros: Number(product / total), remainder: product % total};
  });
  let left = micros - sum(parts, 'micros');
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder ? a.workflow.localeCompare(b.workflow) : a.remainder > b.remainder ? -1 : 1);
  for (const part of ranked) if (left-- > 0) part.micros++;
  return Object.fromEntries(parts.map(p => [p.workflow, p.micros]));
}
function periodSummary(data, period) {
  const rows = data.usage.filter(r => r.period === period.id);
  const outcomes = data.outcomes.filter(o => o.period === period.id);
  const workflows = [...new Set([...rows.map(r => r.workflow), ...outcomes.map(o => o.workflow)].filter(Boolean))].sort();
  const weights = Object.fromEntries(workflows.map(w => [w, sum(rows.filter(r => !r.shared && r.workflow === w), 'tokens')]));
  const shared = rows.filter(r => r.shared);
  const allocation = shared.flatMap(r => Object.entries(allocate(r.cost_micros, weights)).map(([workflow, micros]) => ({source_id: r.id, workflow, micros})));
  const assignedShared = sum(allocation, 'micros');
  const unallocated = sum(rows.filter(r => !r.shared && r.workflow === null), 'cost_micros') + sum(shared, 'cost_micros') - assignedShared;
  const total = sum(rows, 'cost_micros');
  return {
    id: period.id, invoice_micros: period.invoice_micros, total_micros: total,
    reconciliation_gap_micros: period.invoice_micros - total, unallocated_micros: unallocated,
    tokens: sum(rows, 'tokens'), allocation, weights,
    billing_reconciliation: data.billing_lines.filter(b => b.period === period.id).map(b => {
      const matched = rows.filter(r => r.billing_line_id === b.id);
      const usageMicros = sum(matched, 'cost_micros');
      return {billing_line_id: b.id, billed_micros: b.cost_micros, usage_micros: usageMicros, gap_micros: b.cost_micros - usageMicros, usage_ids: matched.map(r => r.id)};
    }),
    workflows: workflows.map(workflow => {
      const direct = rows.filter(r => r.workflow === workflow);
      const success = outcomes.filter(o => o.workflow === workflow && o.status === 'success');
      const successIds = new Set(success.map(o => o.id));
      const linked = direct.filter(r => successIds.has(r.outcome_id));
      const directMicros = sum(direct, 'cost_micros');
      const sharedMicros = sum(allocation.filter(a => a.workflow === workflow), 'micros');
      return {workflow, direct_micros: directMicros, shared_micros: sharedMicros, total_micros: directMicros + sharedMicros,
        successes: success.length, failures: outcomes.filter(o => o.workflow === workflow && o.status === 'failure').length,
        successful_direct_micros: sum(linked, 'cost_micros'),
        linked_successes: success.filter(o => linked.some(r => r.outcome_id === o.id)).length,
        direct_cost_per_success: success.length ? {numerator_micros: sum(linked, 'cost_micros'), denominator: success.length} : null,
        allocated_cost_per_success: success.length ? {numerator_micros: directMicros + sharedMicros, denominator: success.length} : null,
        usage_ids: direct.map(r => r.id), outcome_ids: outcomes.filter(o => o.workflow === workflow).map(o => o.id)};
    })
  };
}
// Future integration boundary: a model may narrate this evidence bundle, but must not
// recalculate money, modify evidence, or present a hypothesis as a verified cause.
export function investigate(data, periods) {
  const [before, after] = periods;
  const models = [...new Set(data.usage.map(r => r.model))].sort();
  return {mode: 'deterministic-evidence-v1', delta_micros: after.total_micros - before.total_micros,
    percent_change: before.total_micros ? (after.total_micros - before.total_micros) / before.total_micros * 100 : null,
    token_delta: after.tokens - before.tokens,
    contributions: models.map(model => {
      const rows = data.usage.filter(r => r.model === model);
      const baseline = sum(rows.filter(r => r.period === before.id), 'cost_micros');
      const current = sum(rows.filter(r => r.period === after.id), 'cost_micros');
      return {model, baseline_micros: baseline, current_micros: current, delta_micros: current - baseline, source_ids: rows.map(r => r.id)};
    }).sort((a, b) => Math.abs(b.delta_micros) - Math.abs(a.delta_micros)),
    unknowns: ['Observed contributions explain the arithmetic, not causality. Price, traffic mix, retry and routing effects are not isolated.',
      'Invoice gaps may reflect missing usage, credits, taxes or timing; none is inferred automatically.',
      'Shared cost is allocated by non-shared tagged token volume; this is a policy, not measured workflow consumption.',
      'Success labels are imported and unverified. Missing cost links can understate direct cost per success. No ROI or business value is estimated.',
      'Period IDs are user-defined: equal duration and complete coverage are not verified.']};
}
export function analyze(input) {
  const data = validate(input);
  const periods = data.periods.map(p => periodSummary(data, p));
  return {synthetic: true, currency: 'USD', periods, investigation: investigate(data, periods), evidence: data};
}
