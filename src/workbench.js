import { validate, allocate, ValidationError } from './engine.js';
export const sum = (rows, key = 'cost_micros') => rows.reduce((n, r) => n + r[key], 0);
export { formatMicros as money } from './money.js';
import { formatMicros as money } from './money.js';
export const dimensions = ['account_id', 'region', 'model', 'workflow', 'team'];
const ref = (kind, id) => `${kind}:${id}`;
const roundRatio = (n, d) => {
  const sign = n < 0n ? -1n : 1n;
  const value = sign * ((sign * n + d / 2n) / d);
  return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(value);
};
const unique = (a) => [...new Set(a)].sort();
const match = (r, filters) =>
  dimensions.every((k) => !filters[k] || (k === 'team' ? r.team : r[k]) === filters[k]);
export function validateScope(data, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ValidationError('Scope must be an object.');
  const allowed = ['baseline', 'current', ...dimensions];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw new ValidationError('Unsupported scope field.');
  const scope = { baseline: data.periods.at(-2).id, current: data.periods.at(-1).id, ...input };
  if (
    !data.periods.some((p) => p.id === scope.baseline) ||
    !data.periods.some((p) => p.id === scope.current) ||
    data.periods.findIndex((p) => p.id === scope.baseline) >=
      data.periods.findIndex((p) => p.id === scope.current)
  )
    throw new ValidationError('Choose a baseline earlier than the comparison period.');
  for (const k of dimensions)
    if (scope[k] !== undefined && (typeof scope[k] !== 'string' || scope[k].length > 80))
      throw new ValidationError(`Invalid ${k} filter.`);
  return scope;
}
// Allocate once across the full account/region pool; filtering only projects this ledger.
// Composite workflow+team keys prevent overhead leaking between teams with the same workflow.
export function buildLedger(data) {
  let expanded = 0;
  return data.usage.flatMap((r) => {
    const base = {
      source_id: r.id,
      source_shared: r.shared,
      period: r.period,
      account_id: r.account_id,
      region: r.region,
      model: r.model,
      outcome_id: r.outcome_id,
      attempt: r.attempt,
      invocation_status: r.invocation_status,
    };
    if (!r.shared)
      return [
        {
          ...base,
          workflow: r.workflow,
          team: r.tags.team,
          cost_micros: r.cost_micros,
          kind: r.workflow ? 'direct' : 'unallocated',
        },
      ];
    const weights = {};
    for (const x of data.usage)
      if (
        !x.shared &&
        x.workflow &&
        x.period === r.period &&
        x.account_id === r.account_id &&
        x.region === r.region
      ) {
        const key = JSON.stringify([x.workflow, x.tags.team]);
        weights[key] = (weights[key] || 0) + x.tokens;
      }
    const parts = Object.entries(allocate(r.cost_micros, weights));
    expanded += parts.length;
    if (expanded > 50000)
      throw new ValidationError(
        'Allocation expansion exceeds 50,000 entries. Reduce workflow/shared-record cardinality.',
      );
    return parts.length
      ? parts.map(([key, cost_micros]) => {
          const [workflow, team] = JSON.parse(key);
          return { ...base, workflow, team, cost_micros, kind: 'shared' };
        })
      : [
          {
            ...base,
            workflow: null,
            team: r.tags.team,
            cost_micros: r.cost_micros,
            kind: 'unallocated',
          },
        ];
  });
}
export function evidenceIndex(data) {
  return Object.fromEntries(
    ['usage', 'outcomes', 'billing_lines'].flatMap((kind) =>
      data[kind].map((r) => [ref(kind, r.id), r]),
    ),
  );
}
export function quality(data, scope = {}) {
  const issues = [];
  const usage = data.usage.filter((r) => match({ ...r, team: r.tags.team }, scope));
  const outcomes = scope.model ? [] : data.outcomes.filter((o) => match(o, scope));
  const narrowBilling = Boolean(scope.model || scope.workflow || scope.team);
  for (const b of data.billing_lines) {
    if (narrowBilling || !match(b, scope)) continue;
    const rows = data.usage.filter((r) => r.billing_line_id === b.id),
      gap = b.cost_micros - sum(rows);
    if (gap)
      issues.push({
        id: `gap-${b.id}`,
        type: 'billing-gap',
        severity: 'warning',
        period: b.period,
        amount_micros: gap,
        title: 'Billing differs from matched usage',
        detail:
          'Billing minus invocation cost. Timing, credits and missing records are not inferred.',
        refs: [ref('billing_lines', b.id), ...rows.map((r) => ref('usage', r.id))],
      });
  }
  for (const p of data.periods) {
    const untagged = usage.filter((r) => r.period === p.id && !r.shared && !r.workflow);
    if (untagged.length)
      issues.push({
        id: `tags-${p.id}`,
        type: 'unallocated',
        severity: 'warning',
        period: p.id,
        amount_micros: sum(untagged),
        title: 'Usage has no workflow tag',
        detail: 'Unattributed cost remains visible and outside workflow outcome metrics.',
        refs: untagged.map((r) => ref('usage', r.id)),
      });
    const missing = outcomes.filter(
      (o) =>
        o.period === p.id &&
        o.status === 'success' &&
        !data.usage.some((r) => r.outcome_id === o.id),
    );
    if (missing.length)
      issues.push({
        id: `coverage-${p.id}`,
        type: 'missing-links',
        severity: 'warning',
        period: p.id,
        title: `${missing.length} successful outcomes have no linked cost`,
        detail:
          'Cost per success is incomplete; a zero linked amount is not evidence of a free workflow.',
        refs: missing.map((r) => ref('outcomes', r.id)),
      });
  }
  for (const period of data.periods) {
    const inconsistent = outcomes.filter(
      (o) =>
        o.period === period.id &&
        o.status === 'failure' &&
        usage.some((r) => r.outcome_id === o.id && r.invocation_status === 'success'),
    );
    if (inconsistent.length)
      issues.push({
        id: `outcome-review-${period.id}`,
        period: period.id,
        type: 'outcome-review',
        severity: 'info',
        title: 'Invocation success differs from workflow failure',
        detail:
          'An invocation can succeed while a workflow fails. Review definitions; neither label is overwritten.',
        refs: inconsistent.map((o) => ref('outcomes', o.id)),
      });
  }
  if (narrowBilling)
    issues.push({
      id: 'billing-scope',
      type: 'scope-limit',
      severity: 'info',
      title: 'Billing gaps unavailable for this dimensional scope',
      detail:
        'Billing lines have no model/workflow/team attribution. Remove these filters to investigate billing gaps; no broader evidence is substituted.',
      refs: [],
    });
  if (scope.model)
    issues.push({
      id: 'outcome-scope',
      type: 'scope-limit',
      severity: 'info',
      title: 'Outcome coverage unavailable for a model filter',
      detail: 'An outcome denominator cannot be attributed to a single model.',
      refs: [],
    });
  if (data.schema_version === 1)
    issues.push({
      id: 'legacy',
      type: 'coverage',
      severity: 'warning',
      title: 'Legacy import has no time windows or outcome dimensions',
      detail: 'Account/region/team-filtered outcome ratios are unavailable for schema v1.',
      refs: [],
    });
  return issues;
}
function summarize(data, ledger, period, scope) {
  const rows = ledger.filter((r) => r.period === period.id && match(r, scope));
  const outcomeScope = { ...scope, model: '' };
  const outcomes = data.outcomes.filter((o) => o.period === period.id && match(o, outcomeScope));
  const successes = outcomes.filter((o) => o.status === 'success'),
    successIds = new Set(successes.map((o) => o.id));
  const linked = rows.filter((r) => r.kind === 'direct' && successIds.has(r.outcome_id));
  const unavailable =
    Boolean(scope.model) ||
    (data.schema_version === 1 && ['account_id', 'region', 'team'].some((k) => scope[k]));
  const covered = successes.filter((o) => linked.some((r) => r.outcome_id === o.id)).length;
  return {
    period: period.id,
    start: period.start,
    end: period.end,
    total_micros: sum(rows),
    direct_micros: sum(rows.filter((r) => r.kind === 'direct')),
    shared_micros: sum(rows.filter((r) => r.kind === 'shared')),
    unallocated_micros: sum(rows.filter((r) => r.kind === 'unallocated')),
    retry_micros: sum(rows.filter((r) => !r.source_shared && r.attempt > 1)),
    failed_invocation_micros: sum(
      rows.filter((r) => !r.source_shared && r.invocation_status === 'failure'),
    ),
    successes: unavailable ? null : successes.length,
    failures: unavailable ? null : outcomes.length - successes.length,
    covered_successes: unavailable ? null : covered,
    direct_cost_per_success:
      !unavailable && successes.length
        ? { numerator_micros: sum(linked), denominator: successes.length }
        : null,
    allocated_cost_per_success:
      !unavailable && successes.length
        ? {
            numerator_micros: sum(rows.filter((r) => r.kind !== 'unallocated')),
            denominator: successes.length,
          }
        : null,
    ratio_note: unavailable
      ? 'Outcome ratios are unavailable for model filters or legacy dimensional scopes.'
      : covered < successes.length
        ? 'Incomplete cost links: treat the ratio as a lower bound on linked cost, not complete cost.'
        : 'Imported success labels and cost coverage are not independently verified.',
    refs: unique([
      ...rows.map((r) => ref('usage', r.source_id)),
      ...outcomes.map((o) => ref('outcomes', o.id)),
    ]),
  };
}
export function overview(input, rawScope = {}) {
  const data = validate(input),
    scope = validateScope(data, rawScope),
    ledger = buildLedger(data);
  const trend = data.periods.map((p) => summarize(data, ledger, p, scope));
  const baseline = trend.find((p) => p.period === scope.baseline),
    current = trend.find((p) => p.period === scope.current);
  const selected = ledger.filter(
    (r) => [scope.baseline, scope.current].includes(r.period) && match(r, scope),
  );
  const contributions = {};
  for (const dim of dimensions) {
    contributions[dim] = unique(selected.map((r) => r[dim] ?? null))
      .map((value) => {
        const rows = selected.filter((r) => (r[dim] ?? null) === value);
        const before = sum(rows.filter((r) => r.period === scope.baseline)),
          after = sum(rows.filter((r) => r.period === scope.current));
        const sources = unique(rows.map((r) => r.source_id)).map((id) =>
          data.usage.find((r) => r.id === id),
        );
        const beforeSources = sources.filter((r) => r.period === scope.baseline),
          afterSources = sources.filter((r) => r.period === scope.current);
        const beforeTokens = sum(beforeSources, 'tokens'),
          afterTokens = sum(afterSources, 'tokens');
        const volume = beforeTokens
          ? roundRatio(BigInt(before) * BigInt(afterTokens - beforeTokens), BigInt(beforeTokens))
          : null;
        return {
          value,
          key: value === null ? 'missing:workflow' : `value:${value}`,
          label: value === null ? 'Unallocated (no workflow tag)' : value,
          baseline_micros: before,
          current_micros: after,
          delta_micros: after - before,
          baseline_tokens: beforeTokens,
          current_tokens: afterTokens,
          baseline_requests: beforeSources.length,
          current_requests: afterSources.length,
          decomposition:
            dim === 'model' &&
            beforeTokens &&
            volume !== null &&
            Number.isSafeInteger(after - before - volume)
              ? {
                  volume_effect_micros: volume,
                  rate_mix_residual_micros: after - before - volume,
                  volume_numerator: (
                    BigInt(before) * BigInt(afterTokens - beforeTokens)
                  ).toString(),
                  volume_denominator: beforeTokens,
                  rounding:
                    'Nearest microdollar, ties away from zero; residual conserves observed delta.',
                }
              : null,
          refs: unique(rows.map((r) => ref('usage', r.source_id))),
        };
      })
      .sort(
        (a, b) =>
          Math.abs(b.delta_micros) - Math.abs(a.delta_micros) ||
          String(a.value ?? '').localeCompare(String(b.value ?? '')),
      );
  }
  const scopedBills = data.billing_lines.filter(
    (b) =>
      (!scope.account_id || scope.account_id === b.account_id) &&
      (!scope.region || scope.region === b.region),
  );
  const reconciliation = scopedBills.map((b) => {
    const rows = data.usage.filter((r) => r.billing_line_id === b.id);
    return {
      ...b,
      usage_micros: sum(rows),
      gap_micros: b.cost_micros - sum(rows),
      refs: [ref('billing_lines', b.id), ...rows.map((r) => ref('usage', r.id))],
    };
  });
  const anomalies = [];
  for (const group of contributions.workflow) {
    if (
      group.baseline_micros > 0 &&
      BigInt(group.delta_micros) * 100n >= BigInt(group.baseline_micros) * 30n &&
      group.delta_micros >= 5_000_000
    )
      anomalies.push({
        id: `spike-${group.key}`,
        title: `${group.label}: spend increased`,
        rule: '≥30% and ≥$5 increase versus selected baseline; a threshold flag, not a statistical prediction.',
        amount_micros: group.delta_micros,
        refs: group.refs,
      });
  }
  if (current.retry_micros > 0)
    anomalies.push({
      id: 'retries',
      title: 'Repeated attempts consumed spend',
      rule: 'Cost of non-shared invocation attempts numbered above one, including unallocated records. Not an estimate of avoidable spend.',
      amount_micros: current.retry_micros,
      refs: unique(
        selected
          .filter((r) => r.period === scope.current && !r.source_shared && r.attempt > 1)
          .map((r) => ref('usage', r.source_id)),
      ),
    });
  const days = (p) => (p.start ? (Date.parse(p.end) - Date.parse(p.start)) / 86400000 : null);
  return {
    scope,
    mode: 'deterministic',
    baseline,
    current,
    trend,
    delta_micros: current.total_micros - baseline.total_micros,
    contributions,
    anomalies,
    reconciliation,
    quality: quality(data),
    allocation: ledger.filter((r) => r.kind === 'shared' && match(r, scope)),
    facets: Object.fromEntries(
      dimensions.map((dim) => [dim, unique(ledger.map((r) => r[dim]).filter(Boolean))]),
    ),
    limitations: [
      ...(days(baseline) !== days(current)
        ? ['Selected periods have different durations; raw totals are not normalized.']
        : []),
      'Anomalies and contributions are descriptive. Token-volume decomposition holds the baseline blended rate fixed; the residual combines price, mix and other effects, not verified causes.',
      'Shared allocation is fixed within each period/account/region using workflow/team token weights before any filters.',
      'Billing reconciliation responds only to account and region filters. Billing has no model, workflow or team attribution.',
      'All costs and account IDs are synthetic. Success labels are imported; cost per outcome is not ROI.',
    ],
  };
}
const questions = {
  variance: 'Why did spend change?',
  retries: 'Investigate retries and failures',
  quality: 'Where are billing and data-quality gaps?',
  outcomes: 'What does a successful workflow cost?',
};
export const suggestions = Object.values(questions);
export function classifyQuestion(question) {
  if (typeof question !== 'string' || !question.trim() || question.length > 500)
    throw new ValidationError('Enter a question between 1 and 500 characters.');
  const q = question.toLowerCase();
  if (
    /\b(delete|deploy|terminate|purchase|credential|secret|execute|shell|email|send|ignore|override|disable|change tags)\b/.test(
      q,
    )
  )
    return null;
  if (/retry|retries|failure|failed/.test(q)) return 'retries';
  if (/billing|reconcil|quality|missing|unallocated|gap/.test(q)) return 'quality';
  if (/outcome|success|resolution|resolved/.test(q)) return 'outcomes';
  if (/spend|variance|cost|increase|change|anomal/.test(q)) return 'variance';
  return null;
}
export function runInvestigation(data, scope, question) {
  const kind = classifyQuestion(question);
  if (!kind)
    return {
      supported: false,
      mode: 'deterministic',
      question,
      message:
        'Offline mode supports spend variance, retries/failures, billing quality, and outcome costs. It cannot execute actions or answer arbitrary questions.',
      suggestions,
      steps: [],
      findings: [],
      recommendations: [],
    };
  const o = overview(data, scope),
    current = o.current,
    baseline = o.baseline;
  scope = o.scope;
  const finding = (id, title, detail, refs, metrics = {}) => ({ id, title, detail, refs, metrics });
  let findings, recommendations;
  if (kind === 'variance') {
    findings = o.contributions.model.map((c, i) =>
      finding(
        `contribution-${i}`,
        c.value,
        `${money(c.baseline_micros)} → ${money(c.current_micros)}; contribution ${money(c.delta_micros)}. This is a measured difference, not a verified cause.`,
        c.refs,
        {
          baseline_micros: c.baseline_micros,
          current_micros: c.current_micros,
          delta_micros: c.delta_micros,
          baseline_tokens: c.baseline_tokens,
          current_tokens: c.current_tokens,
          ...(c.decomposition || {}),
        },
      ),
    );
    for (const f of findings) {
      const d = f.metrics;
      if (d.volume_effect_micros !== undefined)
        f.detail += ` Token-volume effect at the baseline observed blended rate: ${money(d.volume_effect_micros)}; remaining rate/mix effect: ${money(d.rate_mix_residual_micros)}. This counterfactual arithmetic does not isolate actual price changes.`;
    }
    recommendations = [
      {
        title: 'Review routing and workload mix for the largest contributor',
        rationale:
          'Compare quality and token mix before any routing change. No savings are claimed.',
        refs: findings[0]?.refs || [],
      },
    ];
  } else if (kind === 'retries') {
    const rows = data.usage.filter(
      (r) => r.period === scope.current && match({ ...r, team: r.tags.team }, scope) && !r.shared,
    );
    const retries = rows.filter((r) => r.attempt > 1),
      failed = rows.filter((r) => r.invocation_status === 'failure');
    findings = [
      finding(
        'retries',
        'Repeated attempt cost',
        `${money(sum(retries))} across ${retries.length} repeated attempts.`,
        retries.map((r) => ref('usage', r.id)),
        { amount_micros: sum(retries) },
      ),
      finding(
        'failures',
        'Failed invocation cost',
        `${money(sum(failed))} across ${failed.length} failed invocations. Retry and failure sets can overlap; do not add these amounts.`,
        failed.map((r) => ref('usage', r.id)),
        { amount_micros: sum(failed) },
      ),
    ];
    recommendations = [
      {
        title: 'Inspect failure reasons before changing retry policy',
        rationale:
          'Attempt metadata shows correlation only; error codes and workflow quality are needed.',
        refs: unique([...findings[0].refs, ...findings[1].refs]),
      },
    ];
  } else if (kind === 'quality') {
    // Investigation tools never broaden the selected dimensional scope.
    findings = quality(data, scope)
      .filter((x) => x.period === scope.current || !x.period)
      .map((x) =>
        finding(
          x.id,
          x.title,
          x.detail,
          x.refs,
          x.amount_micros !== undefined ? { amount_micros: x.amount_micros } : {},
        ),
      );
    recommendations = [
      {
        title: 'Resolve billing gaps and missing outcome links',
        rationale:
          'Quality evidence follows the selected account/region and invocation/outcome dimensions. Billing gaps are unavailable under model/workflow/team filters.',
        refs: unique(findings.flatMap((f) => f.refs)),
      },
    ];
  } else {
    const ratio = current.direct_cost_per_success;
    findings = [
      finding(
        'outcomes',
        'Direct cost per successful outcome',
        ratio
          ? `${money(ratio.numerator_micros)} / ${ratio.denominator} successful outcomes. ${current.ratio_note}`
          : current.ratio_note,
        current.refs,
        ratio || {},
      ),
      finding(
        'allocated',
        'All allocated workflow cost',
        `${money(current.total_micros - current.unallocated_micros)} includes failures and assigned overhead. Unallocated cost remains separate.`,
        current.refs,
        { amount_micros: current.total_micros - current.unallocated_micros },
      ),
    ];
    recommendations = [
      {
        title: 'Validate success definitions and linked-cost coverage',
        rationale: 'Do not equate a successful outcome with business value or ROI.',
        refs: current.refs,
      },
    ];
  }
  return {
    supported: true,
    mode: 'deterministic',
    kind,
    question,
    title: questions[kind],
    scope: o.scope,
    summary: `${baseline.period} → ${current.period}: scoped spend ${money(baseline.total_micros)} → ${money(current.total_micros)} (${money(o.delta_micros)} change).`,
    steps: [
      { tool: 'validate_scope', detail: 'Validated selected periods and read-only dimensions.' },
      {
        tool: 'compute_ledger',
        detail:
          'Allocated microdollars within original account/region pools; applied filters after allocation.',
      },
      {
        tool: `inspect_${kind}`,
        detail:
          kind === 'quality'
            ? 'Checked scoped billing gaps and coverage; unsupported attribution is disclosed without broadening scope.'
            : 'Computed exact metrics and attached source record references.',
      },
      {
        tool: 'verify_evidence',
        detail: 'Every cited ID belongs to this immutable dataset version.',
      },
    ],
    findings,
    recommendations,
    unknowns: o.limitations,
  };
}
// Used only by model adapter. Names and arguments are checked outside model control.
export function createReadTools(data, scope) {
  const allowed = {
    inspect_variance: 'variance',
    inspect_retries: 'retries',
    inspect_quality: 'quality',
    inspect_outcomes: 'outcomes',
  };
  return {
    names: Object.keys(allowed),
    execute(name, args) {
      if (
        !Object.hasOwn(allowed, name) ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).length
      )
        throw new ValidationError(
          'Tool is not allowed or arguments are invalid. Tools take an empty object and cannot change scope.',
        );
      return runInvestigation(data, scope, questions[allowed[name]]);
    },
  };
}
