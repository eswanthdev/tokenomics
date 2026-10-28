import { createHash } from 'node:crypto';
import { ValidationError } from './engine.js';
const fail = (message) => {
  throw new ValidationError(message);
};
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const services = Object.freeze(['ec2', 's3', 'cloudtrail']);
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const source = (page) => ({
  document: 'AWS_cost_Optimization - Google Sheets.pdf',
  page,
  basis: 'User-provided reviewed rule specification; PDF not independently parsed in this slice.',
});
export const catalog = freeze([
  {
    id: 'EC2-UTIL-001',
    version: '0.1',
    service: 'ec2',
    source: source(1),
    category: 'utilization',
    title: 'Low CPU review candidate',
    requirements: [
      '14 representative days',
      '95% five-minute running-interval coverage',
      'CPU histogram',
      'known peaks represented',
      'dependency review',
    ],
    policy: { days: 14, coverage_bps: 9500, p95_bps: 500, max_bps: 2000, freshness_hours: 48 },
    condition: 'p95 CPU < 5% AND max CPU < 20%; low CPU is not safe rightsizing.',
    exclusions: ['DR', 'batch', 'burstable', 'GPU'],
    dependencies: ['memory', 'io', 'license', 'asg'],
    savings:
      'Unquantified until a validated compatible target, region/OS/tenancy/rates and commitments are reviewed.',
    risk: 'Changing capacity may damage availability or performance.',
    tests: ['coverage', 'peaks', 'dependencies', 'thresholds', 'stale'],
  },
  {
    id: 'S3-LIFECYCLE-001',
    version: '0.1',
    service: 's3',
    source: source(5),
    category: 'storage',
    title: 'Incomplete multipart upload review',
    requirements: [
      'Upload age > 7 days',
      'Two complete paginated snapshots >=24 hours apart',
      'Unchanged bytes and part digest',
      'Activity and lifecycle review',
    ],
    policy: { age_days: 7, snapshot_hours: 24, freshness_hours: 48 },
    condition:
      'Old incomplete upload unchanged between complete snapshots; inactivity is not proof of abandonment.',
    exclusions: ['active', 'long_running'],
    dependencies: ['effective lifecycle cleanup', 'applicable staging storage rate'],
    savings:
      'part bytes / 1073741824 × monthly microdollars per GiB, assuming one month persistence; gross only.',
    risk: 'Aborting an upload can disrupt an active producer. No abort tool exists.',
    tests: ['pagination', 'age', 'changes', 'lifecycle', 'unknown bytes/rate'],
  },
  {
    id: 'CLOUDTRAIL-DUP-001',
    version: '0.1',
    service: 'cloudtrail',
    source: source(6),
    category: 'logging',
    title: 'Management event copy overlap',
    requirements: [
      'Complete selector permissions',
      'Canonical trail ARN',
      'Explicit account/Region coverage',
      'Active management read/write selector atoms',
    ],
    policy: { freshness_hours: 48 },
    condition:
      'Distinct canonical trails overlap in active management selector atoms; shadow representations count once.',
    exclusions: ['disjoint selectors', 'required audit destination'],
    dependencies: [
      'verified surviving coverage',
      'verified avoidable additional-copy volume and applicable rate',
    ],
    savings:
      'verified avoidable additional events / 100000 × applicable microdollars per 100000 events; gross only.',
    risk: 'Audit coverage and required destinations must survive. No disable/delete tool exists.',
    tests: [
      'shadows',
      'organization/member coverage',
      'disjoint',
      'denied',
      'required destinations',
    ],
  },
]);
export const catalogVersion = digest(catalog);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const date = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const tri = (v) => v === true || v === false || v === null;
export const scopeKey = (s) => `${s.account_id}/${s.region}`;
const inScope = (e, s) => e.account_id === s.account_id && e.region === s.region;
export function canonicalTrailArn(facts) {
  const match = /^arn:aws:cloudtrail:([a-z0-9-]+):(\d{12}):trail\/([\w.-]+)$/.exec(
    facts.source_arn || '',
  );
  if (
    typeof facts.source_arn !== 'string' ||
    typeof facts.home_region !== 'string' ||
    !match ||
    !/^[a-z]{2}(-[a-z]+)+-\d$/.test(facts.home_region || '')
  )
    fail('Source trail ARN and home Region are required.');
  return `arn:aws:cloudtrail:${facts.home_region}:${match[2]}:trail/${match[3]}`;
}
const trailSignature = (f) =>
  digest({
    canonical_arn: f.canonical_arn,
    kind: f.kind,
    active: f.active,
    events: [...f.events].sort(),
    required_destination: f.required_destination,
    billing:
      f.billing === null
        ? null
        : {
            avoidable_events: f.billing.avoidable_events,
            rate_micros_per_100k: f.billing.rate_micros_per_100k,
            region: f.billing.region,
            verified: f.billing.verified,
            retained_trail_arn: f.billing.retained_trail_arn,
            surviving_coverage_verified: f.billing.surviving_coverage_verified,
          },
  });
export function validateEvidence(data) {
  if (
    !data ||
    data.schema_version !== 1 ||
    data.synthetic !== true ||
    !date(data.as_of) ||
    !Array.isArray(data.scopes) ||
    !data.scopes.length ||
    data.scopes.length > 20 ||
    !Array.isArray(data.coverage) ||
    !Array.isArray(data.resources) ||
    data.resources.length > 100 ||
    data.coverage.length > 60
  )
    fail('Invalid synthetic resource evidence envelope (max 20 scopes, 100 resources).');
  const scopes = new Set();
  for (const s of data.scopes) {
    if (
      !s ||
      typeof s.account_id !== 'string' ||
      typeof s.region !== 'string' ||
      !/^\d{12}$/.test(s.account_id) ||
      !/^[a-z]{2}(-[a-z]+)+-\d$/.test(s.region) ||
      s.enabled !== true ||
      scopes.has(scopeKey(s))
    )
      fail(
        'Scopes must be unique enabled account/Region pairs. No Region is enabled by this agent.',
      );
    scopes.add(scopeKey(s));
  }
  const ids = new Set();
  for (const e of [...data.coverage, ...data.resources]) {
    if (
      !e ||
      typeof e.account_id !== 'string' ||
      typeof e.region !== 'string' ||
      !text(e.id) ||
      !/^[\w.-]+$/.test(e.id) ||
      ids.has(e.id) ||
      !scopes.has(scopeKey(e)) ||
      !services.includes(e.service) ||
      !date(e.observed_at) ||
      Date.parse(e.observed_at) > Date.parse(data.as_of)
    )
      fail('Invalid/duplicate evidence ID, scope, service or timestamp.');
    ids.add(e.id);
  }
  const coverageKeys = new Set();
  for (const c of data.coverage) {
    const key = `${scopeKey(c)}/${c.service}`;
    if (
      coverageKeys.has(key) ||
      !['complete', 'partial', 'denied', 'unsupported', 'missing'].includes(c.status)
    )
      fail('Coverage must be unique and explicit.');
    coverageKeys.add(key);
  }
  for (const r of data.resources) {
    if (!r.facts || typeof r.facts !== 'object' || Array.isArray(r.facts))
      fail('Resource facts required.');
    const f = r.facts;
    if (r.service === 'ec2') {
      if (
        !date(f.window_start) ||
        !date(f.window_end) ||
        f.window_start >= f.window_end ||
        Date.parse(f.window_end) > Date.parse(r.observed_at)
      )
        fail('CPU observation window required.');
      for (const k of ['expected_samples', 'representative_days'])
        if (f[k] !== null && !integer(f[k])) fail(`Invalid CPU ${k}.`);
      const windowMs = Date.parse(f.window_end) - Date.parse(f.window_start);
      if (
        (f.expected_samples !== null && f.expected_samples > Math.floor(windowMs / 300000)) ||
        (f.representative_days !== null && f.representative_days > Math.floor(windowMs / 86400000))
      )
        fail('CPU counts cannot exceed the observation window.');
      if (!tri(f.peaks_represented) || !f.dependencies || typeof f.dependencies !== 'object')
        fail('CPU peaks and dependencies required.');
      for (const k of ['dr', 'batch', 'burstable', 'gpu', 'memory', 'io', 'license', 'asg'])
        if (!tri(f.dependencies[k])) fail('Dependencies must be true/false/unknown.');
      if (
        f.histogram !== null &&
        (!Array.isArray(f.histogram) ||
          f.histogram.length > 101 ||
          f.histogram.some(
            (b) =>
              !b ||
              !integer(b.cpu_bps) ||
              b.cpu_bps > 10000 ||
              !integer(b.count) ||
              b.count > 100000,
          ) ||
          new Set(f.histogram.map((b) => b.cpu_bps)).size !== f.histogram.length)
      )
        fail('Invalid five-minute CPU histogram.');
      if (
        Array.isArray(f.histogram) &&
        f.expected_samples !== null &&
        f.histogram.reduce((n, b) => n + b.count, 0) > f.expected_samples
      )
        fail('CPU samples exceed expected running intervals.');
    }
    if (r.service === 's3') {
      if (
        !date(f.initiated_at) ||
        Date.parse(f.initiated_at) > Date.parse(data.as_of) ||
        !tri(f.active) ||
        !tri(f.long_running) ||
        !tri(f.lifecycle_effective) ||
        !Array.isArray(f.snapshots) ||
        f.snapshots.length > 2
      )
        fail('Invalid multipart facts.');
      for (const s of f.snapshots)
        if (
          !s ||
          !date(s.at) ||
          Date.parse(s.at) > Date.parse(r.observed_at) ||
          Date.parse(s.at) < Date.parse(f.initiated_at) ||
          typeof s.complete !== 'boolean' ||
          (s.bytes !== null && !integer(s.bytes)) ||
          !text(s.parts_digest)
        )
          fail('Invalid multipart snapshot.');
      if (
        f.rate !== null &&
        (!f.rate ||
          !integer(f.rate.micros_per_gib_month) ||
          f.rate.region !== r.region ||
          f.rate.unit !== 'GiB-month' ||
          f.rate.storage_class !== 'multipart-staging' ||
          f.rate.applicable !== true)
      )
        fail('Rate must match Region and staging class with explicit applicability.');
    }
    if (r.service === 'cloudtrail') {
      if (
        canonicalTrailArn(f) !== f.canonical_arn ||
        (f.kind === 'member' && f.canonical_arn.split(':')[4] !== r.account_id)
      )
        fail('Canonical trail identity disagrees with source/home Region or member account.');
      if (
        !/^arn:aws:cloudtrail:[a-z0-9-]+:\d{12}:trail\/[\w.-]+$/.test(f.canonical_arn) ||
        typeof f.active !== 'boolean' ||
        !['organization', 'member'].includes(f.kind) ||
        !Array.isArray(f.events) ||
        f.events.some((x) => !['Read', 'Write'].includes(x)) ||
        new Set(f.events).size !== f.events.length ||
        !tri(f.required_destination)
      )
        fail('Invalid canonical trail/management selectors.');
      if (
        f.billing !== null &&
        (!f.billing ||
          !integer(f.billing.avoidable_events) ||
          !integer(f.billing.rate_micros_per_100k) ||
          f.billing.region !== r.region ||
          f.billing.verified !== true ||
          !text(f.billing.retained_trail_arn) ||
          f.billing.surviving_coverage_verified !== true)
      )
        fail(
          'Additional-copy basis must include verified volume, rate, Region and retained coverage.',
        );
    }
  }
  return data;
}
const unknownSavings = (reason) => ({
  status: 'unquantified',
  reason,
  numerator: null,
  denominator: null,
  gross_micros: null,
});
function gross(n, d, assumption) {
  return {
    status: 'gross_opportunity',
    numerator: n.toString(),
    denominator: d.toString(),
    gross_micros: ((n + d / 2n) / d).toString(),
    assumption,
    warning:
      'Not realizable bill savings. Commitment/discount/behavior effects unverified. Do not sum overlapping findings.',
  };
}
function assessEC2(f, rule, data) {
  const deps = f.dependencies;
  const blockers = ['memory', 'io', 'license', 'asg']
    .filter((k) => deps[k] !== true)
    .map((k) => `${k} suitability unverified`);
  if (['dr', 'batch', 'burstable', 'gpu'].some((k) => deps[k] === true))
    return {
      status: 'excluded',
      detail: 'DR/batch/burstable/GPU dependency requires a separate assessment.',
      blockers,
    };
  blockers.push(
    ...['dr', 'batch', 'burstable', 'gpu']
      .filter((k) => deps[k] === null)
      .map((k) => `${k} exclusion unknown`),
  );
  const histogram = f.histogram;
  if (
    Date.parse(data.as_of) - Date.parse(f.window_end) > rule.policy.freshness_hours * 3600000 ||
    !histogram ||
    !f.expected_samples ||
    (Date.parse(f.window_end) - Date.parse(f.window_start)) / 86400000 < rule.policy.days ||
    f.representative_days < rule.policy.days ||
    f.representative_days === null ||
    f.peaks_represented !== true
  )
    return {
      status: 'insufficient_evidence',
      detail: 'Representative running intervals and known peaks are not established.',
      blockers,
    };
  const count = histogram.reduce((n, b) => n + b.count, 0);
  if (
    BigInt(count) * 10000n < BigInt(f.expected_samples) * BigInt(rule.policy.coverage_bps) ||
    !count
  )
    return {
      status: 'insufficient_evidence',
      detail: 'Less than required five-minute CPU coverage.',
      blockers,
    };
  let cumulative = 0,
    p95 = 0;
  const bins = histogram.filter((b) => b.count > 0).sort((a, b) => a.cpu_bps - b.cpu_bps);
  for (const b of bins) {
    cumulative += b.count;
    if (cumulative * 100 >= count * 95) {
      p95 = b.cpu_bps;
      break;
    }
  }
  const max = bins.at(-1).cpu_bps;
  return {
    status: p95 < rule.policy.p95_bps && max < rule.policy.max_bps ? 'review' : 'no_finding',
    detail:
      p95 < rule.policy.p95_bps && max < rule.policy.max_bps
        ? 'Low CPU observation only; no compatible target or safe rightsizing decision is established.'
        : 'CPU thresholds are not met; no low-CPU review candidate is established.',
    metrics: {
      p95_cpu_bps: p95,
      max_cpu_bps: max,
      observed_samples: count,
      expected_samples: f.expected_samples,
    },
    blockers,
  };
}
function assessS3(f, data, rule) {
  if (f.active === true || f.long_running === true)
    return { status: 'excluded', detail: 'Known active or long-running producer.' };
  if (f.lifecycle_effective === true)
    return {
      status: 'pending_cleanup',
      detail: 'Effective lifecycle cleanup already covers this upload; no duplicate opportunity.',
    };
  if (f.active === null || f.long_running === null || f.lifecycle_effective === null)
    return {
      status: 'insufficient_evidence',
      detail: 'Activity or lifecycle coverage is unknown.',
    };
  if (Date.parse(data.as_of) - Date.parse(f.initiated_at) <= rule.policy.age_days * 86400000)
    return { status: 'no_finding', detail: 'Upload is not older than policy age.' };
  const [a, b] = f.snapshots;
  if (
    !a ||
    !b ||
    !a.complete ||
    !b.complete ||
    Date.parse(b.at) - Date.parse(a.at) < rule.policy.snapshot_hours * 3600000 ||
    Date.parse(data.as_of) - Date.parse(b.at) > rule.policy.freshness_hours * 3600000
  )
    return {
      status: 'insufficient_evidence',
      detail: 'Two fresh, complete paginated snapshots at least 24h apart are required.',
    };
  if (
    a.parts_digest !== b.parts_digest ||
    (a.bytes !== null && b.bytes !== null && a.bytes !== b.bytes)
  )
    return { status: 'no_finding', detail: 'Upload changed; inactivity is not established.' };
  if (a.bytes === null || b.bytes === null)
    return {
      status: 'insufficient_evidence',
      detail: 'Part bytes are unknown; unchanged storage cannot be established.',
      savings: unknownSavings('Unknown part bytes.'),
    };
  if (b.bytes === 0)
    return { status: 'no_finding', detail: 'Complete snapshots report zero stored part bytes.' };
  return {
    status: 'review',
    detail:
      'Old unchanged incomplete upload; absence of activity does not prove abandonment. Confirm with producer.',
    savings: f.rate
      ? gross(
          BigInt(b.bytes) * BigInt(f.rate.micros_per_gib_month),
          1073741824n,
          'One month persistence of eligible staging parts at the supplied illustrative rate.',
        )
      : unknownSavings('Applicable staging rate unknown.'),
    metrics: { part_bytes: b.bytes },
  };
}
function assessTrails(resources) {
  const groups = new Map();
  for (const r of resources) {
    const list = groups.get(r.facts.canonical_arn) || [];
    list.push(r);
    groups.set(r.facts.canonical_arn, list);
  }
  const canonical = [...groups.values()];
  if (canonical.some((g) => g.some((r) => trailSignature(r.facts) !== trailSignature(g[0].facts))))
    return [
      {
        resource_id: null,
        refs: resources.map((r) => r.id),
        status: 'insufficient_evidence',
        detail: 'Conflicting canonical representations prevent trustworthy selector comparison.',
      },
    ];
  return canonical.map((representations) => {
    const r = representations[0],
      f = r.facts;
    const refs = representations.map((x) => x.id);
    // Conflicting shadow representations never silently select one selector set.
    if (representations.some((x) => trailSignature(x.facts) !== trailSignature(f)))
      return {
        resource_id: r.id,
        refs,
        status: 'insufficient_evidence',
        detail: 'Canonical shadow representations disagree.',
      };
    const overlaps = canonical.filter(
      (g) =>
        g[0].facts.canonical_arn !== f.canonical_arn &&
        f.active &&
        g[0].facts.active &&
        f.events.some((e) => g[0].facts.events.includes(e)),
    );
    if (!overlaps.length)
      return {
        resource_id: r.id,
        refs,
        status: 'no_finding',
        detail: 'No distinct active canonical management-selector overlap.',
      };
    const allRefs = [...refs, ...overlaps.flatMap((g) => g.map((x) => x.id))];
    if (f.required_destination === true)
      return {
        resource_id: r.id,
        refs: allRefs,
        status: 'excluded',
        detail:
          'Required audit destination must be preserved; overlap is not removable redundancy.',
      };
    const billing = f.billing;
    const retained = overlaps.find((g) => g[0].facts.canonical_arn === billing?.retained_trail_arn);
    const safeRetained =
      retained &&
      retained.every((x) => trailSignature(x.facts) === trailSignature(retained[0].facts)) &&
      f.events.every((e) => retained[0].facts.events.includes(e));
    return {
      resource_id: r.id,
      refs: allRefs,
      status: 'review',
      detail:
        'Canonical management-selector overlap observed; preserve destinations and verify surviving coverage before any change.',
      savings:
        billing && safeRetained && f.required_destination === false
          ? gross(
              BigInt(billing.avoidable_events) * BigInt(billing.rate_micros_per_100k),
              100000n,
              'Only supplied verified avoidable additional management copies; not total event volume.',
            )
          : unknownSavings(
              'Avoidable copy volume/rate, required destinations or surviving coverage unverified.',
            ),
    };
  });
}
export function assessTask(data, task) {
  if (
    !task ||
    Object.keys(task).some((k) => !['rule_id', 'scope', 'dataset_id'].includes(k)) ||
    task.dataset_id !== digest(data)
  )
    fail('Invalid task or evidence snapshot.');
  const rule = catalog.find((r) => r.id === task.rule_id);
  if (
    !rule ||
    !task.scope ||
    Object.keys(task.scope).some((k) => !['account_id', 'region'].includes(k)) ||
    !data.scopes.some((s) => inScope(s, task.scope))
  )
    fail('Unauthorized worker rule or scope.');
  const cov = data.coverage.find((c) => c.service === rule.service && inScope(c, task.scope));
  const records = data.resources.filter(
    (r) => r.service === rule.service && inScope(r, task.scope),
  );
  const stale = (e) =>
    Date.parse(data.as_of) - Date.parse(e.observed_at) > rule.policy.freshness_hours * 3600000;
  let results;
  if (!cov || cov.status !== 'complete' || stale(cov))
    results = [
      {
        resource_id: null,
        refs: cov ? [cov.id] : [],
        status: 'insufficient_evidence',
        detail: `Coverage ${!cov ? 'missing' : stale(cov) ? 'stale' : cov.status}; missing evidence is never zero.`,
      },
    ];
  else if (!records.length)
    results = [
      {
        resource_id: null,
        refs: [cov.id],
        status: 'no_finding',
        detail: 'Complete synthetic inventory contains no resources for this service/scope.',
      },
    ];
  else if (rule.service === 'cloudtrail' && records.some(stale))
    results = [
      {
        resource_id: null,
        refs: records.map((r) => r.id),
        status: 'insufficient_evidence',
        detail: 'Stale trail coverage prevents reliable overlap assessment.',
      },
    ];
  else if (rule.service === 'cloudtrail') results = assessTrails(records);
  else
    results = records.map((r) => ({
      resource_id: r.id,
      refs: [r.id],
      ...(stale(r)
        ? { status: 'insufficient_evidence', detail: 'Resource evidence is stale.' }
        : rule.service === 'ec2'
          ? assessEC2(r.facts, rule, data)
          : assessS3(r.facts, data, rule)),
    }));
  return results.map((r) => {
    const refs = [...new Set([...(cov ? [cov.id] : []), ...r.refs])].sort();
    return {
      ...r,
      refs,
      rule_id: rule.id,
      rule_version: rule.version,
      policy: rule.policy,
      risk: rule.risk,
      coverage: {
        status: cov?.status || 'missing',
        observed_at: cov?.observed_at || null,
        freshness: cov ? (stale(cov) ? 'stale' : 'fresh') : 'unknown',
      },
      source: rule.source,
      scope: task.scope,
      dataset_id: task.dataset_id,
      as_of: data.as_of,
      savings: r.savings || unknownSavings(rule.savings),
      id: digest({
        dataset: task.dataset_id,
        rule: rule.id,
        version: rule.version,
        scope: task.scope,
        resource: r.resource_id,
      }),
    };
  });
}
