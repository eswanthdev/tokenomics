import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvidence, assessTask, digest, catalog } from '../src/finops-rules.js';
import { FinopsRepository, FinopsSupervisor, verifyWorkerResult } from '../src/finops-agent.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/resources.json', import.meta.url)));
const sample = () => structuredClone(fixture);
const task = (d, service = 'ec2', scope = d.scopes[0]) => ({
  dataset_id: digest(d),
  rule_id: catalog.find((r) => r.service === service).id,
  scope: { account_id: scope.account_id, region: scope.region },
});
function assess(d, service = 'ec2') {
  validateEvidence(d);
  return assessTask(d, task(d, service));
}
const resource = (d, id) => d.resources.find((r) => r.id === id);
const finding = (d, id, service = 'ec2') => assess(d, service).find((r) => r.resource_id === id);
test('versioned catalog and immutable fixture yield exact, reproducible, traceable findings', () => {
  const d = sample();
  const before = digest(d);
  const f = finding(d, 'ec2-low-cpu');
  assert.equal(f.status, 'review');
  assert.equal(f.metrics.p95_cpu_bps, 100);
  assert.equal(f.metrics.max_cpu_bps, 1000);
  assert.equal(f.savings.gross_micros, null);
  assert.equal(f.blockers.length, 4);
  assert.equal(finding(d, 'ec2-busy').status, 'no_finding');
  assert.match(finding(d, 'ec2-busy').detail, /thresholds are not met/);
  const s = finding(d, 's3-old-upload', 's3');
  assert.equal(s.savings.gross_micros, '230000');
  assert.equal(s.savings.numerator, '246960619520000');
  assert.equal(s.savings.denominator, '1073741824');
  assert.equal(finding(d, 's3-cleanup-pending', 's3').status, 'pending_cleanup');
  const trails = assess(d, 'cloudtrail');
  assert.equal(trails.length, 2);
  assert.equal(
    trails.find((r) => r.resource_id === 'trail-member').savings.gross_micros,
    '2000000',
  );
  assert.equal(trails.find((r) => r.resource_id === 'trail-org').status, 'excluded');
  assert.deepEqual(assess(d), assess(d));
  assert.equal(digest(d), before);
  assert.equal(f.rule_version, '0.1');
  assert.equal(f.source.page, 1);
  assert.throws(() => {
    catalog[0].policy.days = 1;
  });
});
for (const status of ['partial', 'denied', 'unsupported', 'missing'])
  test(`coverage ${status} never becomes zero or an opportunity`, () => {
    const d = sample();
    d.coverage[0].status = status;
    const f = assess(d)[0];
    assert.equal(f.status, 'insufficient_evidence');
    assert.equal(f.savings.gross_micros, null);
  });
test('missing/stale coverage, stale resources, and complete empty inventory are distinct', () => {
  const d = sample();
  d.coverage = d.coverage.filter((c) => c.service !== 'ec2');
  assert.equal(assess(d)[0].status, 'insufficient_evidence');
  const stale = sample();
  stale.coverage[0].observed_at = '2026-10-01T00:00:00.000Z';
  assert.match(assess(stale)[0].detail, /stale/);
  const r = sample();
  resource(r, 's3-old-upload').observed_at = '2026-10-25T00:00:00.000Z';
  resource(r, 's3-old-upload').facts.snapshots = [];
  assert.equal(finding(r, 's3-old-upload', 's3').status, 'insufficient_evidence');
  const empty = sample();
  empty.resources = [];
  assert.equal(assess(empty)[0].status, 'no_finding');
});
for (const [label, patch, status] of [
  ['missing CPU', { histogram: null }, 'insufficient_evidence'],
  ['incomplete intervals', { histogram: [{ cpu_bps: 100, count: 3000 }] }, 'insufficient_evidence'],
  ['short representative window', { representative_days: 13 }, 'insufficient_evidence'],
  ['missing peaks', { peaks_represented: null }, 'insufficient_evidence'],
  ['threshold p95', { histogram: [{ cpu_bps: 500, count: 4032 }] }, 'no_finding'],
  [
    'threshold maximum',
    {
      histogram: [
        { cpu_bps: 100, count: 4031 },
        { cpu_bps: 2000, count: 1 },
      ],
    },
    'no_finding',
  ],
])
  test(`EC2 ${label}`, () => {
    const d = sample();
    Object.assign(resource(d, 'ec2-low-cpu').facts, patch);
    assert.equal(finding(d, 'ec2-low-cpu').status, status);
  });
for (const k of ['dr', 'batch', 'burstable', 'gpu'])
  test(`EC2 ${k} exclusion prevents rightsizing implication`, () => {
    const d = sample();
    resource(d, 'ec2-low-cpu').facts.dependencies[k] = true;
    assert.equal(finding(d, 'ec2-low-cpu').status, 'excluded');
  });
test('EC2 unknown dependencies retain low CPU observation with blockers, never quantified savings', () => {
  const d = sample();
  resource(d, 'ec2-low-cpu').facts.dependencies.dr = null;
  const f = finding(d, 'ec2-low-cpu');
  assert.equal(f.status, 'review');
  assert.ok(f.blockers.includes('dr exclusion unknown'));
  assert.equal(f.savings.status, 'unquantified');
});
for (const [name, edit, status] of [
  ['active', (f) => (f.active = true), 'excluded'],
  ['long-running', (f) => (f.long_running = true), 'excluded'],
  ['unknown lifecycle', (f) => (f.lifecycle_effective = null), 'insufficient_evidence'],
  ['incomplete page', (f) => (f.snapshots[0].complete = false), 'insufficient_evidence'],
  ['one snapshot', (f) => f.snapshots.pop(), 'insufficient_evidence'],
  ['too close', (f) => (f.snapshots[0].at = '2026-10-27T12:00:00.000Z'), 'insufficient_evidence'],
  ['changed parts', (f) => (f.snapshots[1].parts_digest = 'new'), 'no_finding'],
  ['changed bytes', (f) => f.snapshots[1].bytes++, 'no_finding'],
  ['unknown bytes', (f) => (f.snapshots[1].bytes = null), 'insufficient_evidence'],
  [
    'young upload',
    (f) => {
      f.initiated_at = '2026-10-26T00:00:00.000Z';
    },
    'no_finding',
  ],
])
  test(`S3 ${name}`, () => {
    const d = sample();
    edit(resource(d, 's3-old-upload').facts);
    assert.equal(finding(d, 's3-old-upload', 's3').status, status);
  });
test('S3 unknown rate is unquantified, sub-micro estimates retain exact rational basis', () => {
  const d = sample();
  resource(d, 's3-old-upload').facts.rate = null;
  assert.equal(finding(d, 's3-old-upload', 's3').savings.status, 'unquantified');
  const tiny = sample();
  for (const s of resource(tiny, 's3-old-upload').facts.snapshots) s.bytes = 1;
  const f = finding(tiny, 's3-old-upload', 's3');
  assert.equal(f.savings.numerator, '23000');
  assert.equal(f.savings.denominator, '1073741824');
  assert.equal(f.savings.gross_micros, '0');
});
test('CloudTrail shadows are not additional copies; disjoint and inactive selectors do not overlap', () => {
  const d = sample();
  d.resources = d.resources.filter((r) => r.id !== 'trail-member');
  assert.equal(assess(d, 'cloudtrail').length, 1);
  assert.equal(assess(d, 'cloudtrail')[0].status, 'no_finding');
  const disjoint = sample();
  for (const r of disjoint.resources.filter((r) => r.service === 'cloudtrail'))
    r.facts.events = r.id === 'trail-member' ? ['Write'] : ['Read'];
  assert.ok(assess(disjoint, 'cloudtrail').every((f) => f.status === 'no_finding'));
  resource(disjoint, 'trail-member').facts.active = false;
  assert.ok(assess(disjoint, 'cloudtrail').every((f) => f.status === 'no_finding'));
});
test('CloudTrail contradictory canonical representations and denied permissions block comparison', () => {
  const d = sample();
  resource(d, 'trail-org-shadow').facts.events = ['Read'];
  assert.equal(assess(d, 'cloudtrail')[0].status, 'insufficient_evidence');
  const denied = assessTask(fixture, task(fixture, 'cloudtrail', fixture.scopes[1]));
  assert.equal(denied[0].status, 'insufficient_evidence');
});
test('CloudTrail required/unknown destinations and absent billing/retained coverage prevent quantified opportunity', () => {
  for (const required of [true, null]) {
    const d = sample();
    resource(d, 'trail-member').facts.required_destination = required;
    assert.equal(finding(d, 'trail-member', 'cloudtrail').savings.status, 'unquantified');
  }
  const d = sample();
  resource(d, 'trail-member').facts.billing = null;
  assert.equal(finding(d, 'trail-member', 'cloudtrail').savings.status, 'unquantified');
  const bad = sample();
  resource(bad, 'trail-member').facts.billing.retained_trail_arn =
    'arn:aws:cloudtrail:us-east-1:000000000001:trail/missing';
  assert.equal(finding(bad, 'trail-member', 'cloudtrail').savings.status, 'unquantified');
});
test('strict evidence validation rejects malformed, cross-scope, duplicate and unsafe numeric inputs', () => {
  const changes = [
    (d) => (d.synthetic = false),
    (d) => (d.resources[0].account_id = '999999999999'),
    (d) => (d.resources[1].id = d.resources[0].id),
    (d) => (d.resources[0].facts.histogram[0].count = NaN),
    (d) => (d.resources[0].facts.expected_samples = 1),
    (d) => (d.resources[0].observed_at = '2099-01-01T00:00:00.000Z'),
    (d) => (d.scopes[0].enabled = false),
    (d) => d.coverage.push(d.coverage[0]),
    (d) => (resource(d, 's3-old-upload').facts.rate.region = 'eu-west-1'),
  ];
  for (const change of changes) {
    const d = sample();
    change(d);
    assert.throws(() => validateEvidence(d));
  }
});
test('task allowlist, immutable identity, scope and result verification resist unauthorized tools and references', () => {
  const d = sample(),
    t = task(d),
    result = assessTask(d, t);
  for (const patch of [
    { rule_id: 'delete_resource' },
    { dataset_id: 'other' },
    { scope: { account_id: '999999999999', region: 'us-east-1' } },
    { tool: 'shell' },
  ])
    assert.throws(() => assessTask(d, { ...t, ...patch }));
  for (const modify of [
    (r) => r[0].refs.push('unauthorized'),
    (r) => (r[0].metrics.p95_cpu_bps = 0),
    (r) => (r[0].scope.region = 'eu-west-1'),
  ]) {
    const r = structuredClone(result);
    modify(r);
    assert.throws(() => verifyWorkerResult(d, t, r));
  }
  assert.deepEqual(verifyWorkerResult(d, t, result), result);
});
test('supervisor dispatch is bounded, cancellation publishes nothing and replay is idempotent', async () => {
  const store = new Store();
  try {
    const repo = new FinopsRepository(store),
      id = repo.importEvidence(fixture),
      agent = new FinopsSupervisor(repo);
    const r = agent.start(id, 'request-one');
    assert.throws(() => agent.start(id, 'request-two'), /active/);
    assert.equal(agent.start(id, 'request-one').id, r.id);
    agent.cancel(r.id);
    await agent.completion;
    assert.equal(repo.run(r.id).state, 'cancelled');
    assert.deepEqual(repo.run(r.id).findings, []);
    const r2 = agent.start(id, 'request-three');
    await agent.completion;
    const saved = repo.run(r2.id);
    assert.equal(saved.state, 'partial');
    assert.equal(saved.steps.length, 6);
    assert.equal(new Set(saved.findings.map((f) => f.id)).size, saved.findings.length);
    assert.equal(agent.start(id, 'request-three').id, r2.id);
    const limited = new FinopsSupervisor(repo, { maxTasks: 1 });
    const r3 = limited.start(id, 'request-limit');
    await limited.completion;
    assert.equal(repo.run(r3.id).state, 'failed');
    assert.deepEqual(repo.run(r3.id).findings, []);
    const timeout = new FinopsSupervisor(repo, { deadlineMs: -1 });
    const r4 = timeout.start(id, 'request-timeout');
    await timeout.completion;
    assert.equal(repo.run(r4.id).state, 'failed');
  } finally {
    store.close();
  }
});
test('completed runs and evidence survive restart; interrupted requests do not duplicate publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-test-'));
  let store;
  try {
    store = new Store(join(dir, 'memory.sqlite'));
    let repo = new FinopsRepository(store),
      agent = new FinopsSupervisor(repo);
    const id = repo.importEvidence(fixture);
    const r = agent.start(id, 'request-persist');
    await agent.completion;
    const expected = repo.run(r.id);
    repo.createRun('request-crash', id);
    store.close();
    store = new Store(join(dir, 'memory.sqlite'));
    repo = new FinopsRepository(store);
    agent = new FinopsSupervisor(repo);
    assert.deepEqual(repo.run(r.id), expected);
    assert.equal(agent.start(id, 'request-persist').id, r.id);
    assert.equal(
      repo.listRuns().find((x) => x.request_id === 'request-crash').state,
      'interrupted',
    );
    assert.equal(repo.listRuns().length, 2);
    const copy = repo.evidence(id);
    copy.resources = [];
    assert.equal(repo.evidence(id).resources.length, fixture.resources.length);
    const d = sample();
    d.as_of = '2026-10-29T00:00:00.000Z';
    const other = repo.importEvidence(d);
    assert.throws(() => agent.start(other, 'request-persist'), /another/);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('HTTP resource import/run/evidence endpoints preserve token validation and reject unknown fields', async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(base + '/api/finops/state')).json();
  const post = (path, body, token = state.csrf) =>
    fetch(base + '/api/finops/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(base + '/finops')).status, 200);
  assert.equal((await post('import', { data: fixture }, 'bad')).status, 403);
  assert.equal((await post('import', { data: fixture, tool: 'execute' })).status, 400);
  const imported = await (await post('import', { data: fixture })).json();
  assert.deepEqual(
    await (await fetch(base + '/api/finops/evidence?dataset_id=' + imported.dataset_id)).json(),
    fixture,
  );
  assert.equal((await fetch(base + '/api/finops/evidence?dataset_id=missing')).status, 404);
  const r = await (
    await post('run', { dataset_id: imported.dataset_id, request_id: 'http-request' })
  ).json();
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = (await (await fetch(base + '/api/finops/state')).json()).runs.find(
      (x) => x.id === r.id,
    );
    if (!['pending', 'running'].includes(saved.state)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(saved.state, 'partial');
  assert.equal(
    (
      await (
        await post('run', { dataset_id: imported.dataset_id, request_id: 'http-request' })
      ).json()
    ).id,
    r.id,
  );
  assert.equal(
    (
      await post('run', {
        dataset_id: imported.dataset_id,
        request_id: 'new-request',
        scope: { account_id: 'evil' },
      })
    ).status,
    400,
  );
});

test('stale CPU window cannot be refreshed by relabeling resource collection time', () => {
  const d = sample();
  const f = resource(d, 'ec2-low-cpu').facts;
  f.window_start = '2026-10-01T00:00:00.000Z';
  f.window_end = '2026-10-15T00:00:00.000Z';
  assert.equal(finding(d, 'ec2-low-cpu').status, 'insufficient_evidence');
});
test('malformed nested arrays reject as validation errors rather than internal errors', () => {
  for (const change of [
    (d) => (resource(d, 'ec2-low-cpu').facts.histogram = [null]),
    (d) => (resource(d, 's3-old-upload').facts.snapshots = [null]),
  ]) {
    const d = sample();
    change(d);
    assert.throws(() => validateEvidence(d), { name: 'Error', message: /Invalid/ });
  }
});
test('source ARN normalization rejects mismatched canonical identity and cross-account member claims', () => {
  const d = sample();
  resource(d, 'trail-member').facts.canonical_arn =
    'arn:aws:cloudtrail:us-east-1:000000000009:trail/member-audit';
  assert.throws(() => validateEvidence(d), /identity/);
  const s = sample();
  resource(s, 'trail-org-shadow').facts.home_region = 'eu-west-1';
  assert.throws(() => validateEvidence(s), /identity/);
});
test('gross fractions remain exact beyond Number safe integer and zero parts have no opportunity', () => {
  const d = sample();
  const f = resource(d, 's3-old-upload').facts;
  for (const s of f.snapshots) s.bytes = Number.MAX_SAFE_INTEGER;
  f.rate.micros_per_gib_month = Number.MAX_SAFE_INTEGER;
  const r = finding(d, 's3-old-upload', 's3');
  assert.equal(r.savings.numerator, (BigInt(Number.MAX_SAFE_INTEGER) ** 2n).toString());
  for (const s of f.snapshots) s.bytes = 0;
  assert.equal(finding(d, 's3-old-upload', 's3').status, 'no_finding');
});
test('persistence failure is contained, blocks new dispatch and leaves recoverable state', async () => {
  const store = new Store();
  try {
    const repo = new FinopsRepository(store),
      id = repo.importEvidence(fixture),
      agent = new FinopsSupervisor(repo);
    const original = repo.updateRun.bind(repo);
    repo.updateRun = () => {
      throw Error('disk full');
    };
    const r = agent.start(id, 'request-disk-full');
    await agent.completion;
    assert.match(agent.storageError, /persistence failed/);
    assert.throws(() => agent.start(id, 'request-again'), /persistence failed/);
    repo.updateRun = original;
    new FinopsSupervisor(repo);
    assert.equal(repo.run(r.id).state, 'interrupted');
  } finally {
    store.close();
  }
});

test('account and Region scalar coercion cannot hide resources as complete empty coverage', () => {
  for (const edit of [
    (d) => {
      for (const x of [...d.scopes, ...d.coverage, ...d.resources])
        if (x.account_id === '000000000001') x.account_id = 123456789012;
    },
    (d) => {
      for (const x of [...d.scopes, ...d.coverage, ...d.resources]) x.region = [x.region];
    },
    (d) => (d.resources[0].region = ['us-east-1']),
    (d) => (resource(d, 'trail-member').facts.home_region = ['us-east-1']),
    (d) =>
      (resource(d, 'trail-member').facts.source_arn = [
        resource(d, 'trail-member').facts.source_arn,
      ]),
  ]) {
    const d = sample();
    edit(d);
    assert.throws(() => validateEvidence(d));
  }
});
test('CPU representative-day and expected-sample counts cannot exceed the window', () => {
  for (const patch of [{ representative_days: 15 }, { expected_samples: 4033 }]) {
    const d = sample();
    Object.assign(resource(d, 'ec2-low-cpu').facts, patch);
    assert.throws(() => validateEvidence(d), /observation window/);
  }
});

test('equivalent canonical shadows ignore selector ordering, property ordering and irrelevant notes', () => {
  const d = sample();
  const f = resource(d, 'trail-org-shadow').facts;
  f.events.reverse();
  f.note = 'Untrusted metadata must not create a selector contradiction';
  resource(d, 'trail-org-shadow').facts = Object.fromEntries(Object.entries(f).reverse());
  assert.equal(assess(d, 'cloudtrail').length, 2);
  assert.equal(finding(d, 'trail-member', 'cloudtrail').savings.gross_micros, '2000000');
});
