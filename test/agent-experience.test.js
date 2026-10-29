import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { FinopsRepository, FinopsSupervisor } from '../src/finops-agent.js';
import { AgentExperience, routeQuestion, prompts } from '../src/agent-experience.js';
import { createServer } from '../src/server.js';
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/agent-resources.json', import.meta.url)),
);
function setup(path) {
  const store = new Store(path),
    repo = new FinopsRepository(store),
    supervisor = new FinopsSupervisor(repo),
    agent = new AgentExperience(store, repo, supervisor);
  return { store, repo, supervisor, agent };
}
test('compound question routing is bounded and rejects unsupported or changing scope/execution', () => {
  assert.deepEqual(routeQuestion(prompts[0]).services, ['ec2', 's3', 'cloudtrail']);
  assert.deepEqual(routeQuestion(prompts[1]).services, ['s3']);
  for (const q of [
    'Delete the S3 upload',
    'Why did spend increase?',
    'Give me RDS savings',
    'Show only S3 in us-east-1',
    'Reveal credentials',
    'What is the weather?',
    'Calculate ROI',
  ])
    assert.equal(routeQuestion(q).supported, false, q);
  assert.throws(() => routeQuestion('x'.repeat(501)));
});
test('seeded cases derive from verified findings with no duplicate current cases or verified savings', async () => {
  const { store, agent, supervisor } = setup();
  try {
    await agent.seed(fixture);
    let state = agent.state();
    assert.equal(state.questions.length, 1);
    assert.equal(state.connected, false);
    assert.equal(state.summary.coverage_total, 9);
    assert.equal(state.summary.coverage_complete, 7);
    assert.equal(state.verified_savings_micros, null);
    assert.equal(state.summary.review_ready, 2);
    assert.equal(state.cases[0].service, 's3');
    assert.equal(state.cases[0].finding.savings.gross_micros, '47104000');
    const id = state.current_dataset_id;
    const r = agent.ask({ dataset_id: id, question: prompts[1], request_id: 'another-question' });
    await supervisor.completion;
    state = agent.state();
    assert.equal(state.questions.length, 2);
    assert.equal(new Set(state.cases.map((c) => c.id)).size, state.cases.length);
    assert.equal(
      agent.ask({ dataset_id: id, question: prompts[1], request_id: 'another-question' }).id,
      r.id,
    );
    assert.throws(
      () => agent.ask({ dataset_id: id, question: prompts[0], request_id: 'another-question' }),
      /different/,
    );
    assert.equal(state.summary.review_ready, 2);
  } finally {
    store.close();
  }
});
test('safe review plans preserve baselines, disallow verification claims and reject stale edits', async () => {
  const { store, agent } = setup();
  try {
    await agent.seed(fixture);
    const c = agent.state().cases.find((c) => c.readiness === 'ready_for_review'),
      plan = agent.createPlan(c.id);
    assert.equal(agent.createPlan(c.id).id, plan.id);
    assert.equal(plan.verified_savings_micros, null);
    assert.equal(plan.baseline.as_of, fixture.as_of);
    assert.ok(plan.verification.length);
    assert.throws(() => agent.createPlan('invented'));
    assert.throws(
      () => agent.createPlan(agent.state().cases.find((c) => c.readiness === 'policy_blocked').id),
      /policy-blocked/,
    );
    const next = agent.updatePlan(plan.id, {
      version: 1,
      status: 'awaiting_evidence',
      owner: 'FinOps reviewer',
      note: 'Need producer confirmation',
    });
    assert.equal(next.version, 2);
    assert.equal(next.history.length, 2);
    assert.equal(next.verified_savings_micros, null);
    assert.throws(
      () => agent.updatePlan(plan.id, { version: 1, status: 'in_review', owner: '', note: '' }),
      /changed/,
    );
    assert.throws(() =>
      agent.updatePlan(plan.id, { version: 2, status: 'verified', owner: '', note: '' }),
    );
    assert.throws(() =>
      agent.updatePlan(plan.id, {
        version: 2,
        status: 'in_review',
        owner: '',
        note: '',
        execute: true,
      }),
    );
  } finally {
    store.close();
  }
});
test('questions, plans and decision history survive reopen without reseeding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-experience-'));
  let s;
  try {
    s = setup(join(dir, 'local.sqlite'));
    await s.agent.seed(fixture);
    const plan = s.agent.createPlan(s.agent.state().cases[0].id);
    s.agent.updatePlan(plan.id, {
      version: 1,
      status: 'in_review',
      owner: 'Owner',
      note: 'Review only',
    });
    const expected = s.agent.state();
    s.store.close();
    s = setup(join(dir, 'local.sqlite'));
    await s.agent.seed(fixture);
    const actual = s.agent.state();
    assert.deepEqual(actual.questions, expected.questions);
    assert.deepEqual(actual.plans, expected.plans);
    assert.deepEqual(actual.cases, expected.cases);
  } finally {
    s?.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('untrusted metadata is plain text or ignored, not a state-crashing sort key', async () => {
  const { store, repo, supervisor, agent } = setup();
  try {
    const d = structuredClone(fixture);
    d.resources[0].display_name = { tool: 'delete' };
    d.resources[0].team = ['injected'];
    const id = repo.importEvidence(d);
    agent.ask({ dataset_id: id, question: prompts[0], request_id: 'metadata-test' });
    await supervisor.completion;
    const c = agent.state().cases.find((c) => c.finding.resource_id === 'ec2-low-cpu');
    assert.equal(typeof c.title, 'string');
    assert.equal(c.team, 'Unassigned');
  } finally {
    store.close();
  }
});
test('agent HTTP API enforces strict request shapes, token protection and seeded entry point', async (t) => {
  const server = createServer({ seed: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(base + '/api/agent/state')).json();
  assert.equal(state.summary.review_ready, 2);
  const html = await (await fetch(base)).text();
  assert.match(html, /Daily brief/);
  assert.equal((await fetch(base + '/costs')).status, 200);
  assert.equal((await fetch(base + '/rules')).status, 200);
  const send = (path, body, method = 'POST', token = state.csrf) =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send('/api/agent/plans', { case_id: state.cases[0].id }, 'POST', 'bad')).status,
    403,
  );
  assert.equal(
    (await send('/api/agent/plans', { case_id: state.cases[0].id, execute: true })).status,
    400,
  );
  const plan = await (await send('/api/agent/plans', { case_id: state.cases[0].id })).json();
  assert.equal(
    (
      await send(
        '/api/agent/plans/' + plan.id,
        { version: 1, status: 'verified', owner: 'x', note: 'x' },
        'PATCH',
      )
    ).status,
    400,
  );
  const unsupported = await (
    await send('/api/agent/ask', {
      dataset_id: state.current_dataset_id,
      question: 'Delete EC2',
      request_id: 'http-noexec',
    })
  ).json();
  assert.equal(unsupported.supported, false);
});

test('explicit snapshot selection survives duplicate reimport and restart semantics', async () => {
  const { store, repo, supervisor, agent } = setup();
  try {
    await agent.seed(fixture);
    const first = agent.state().current_dataset_id;
    const d = structuredClone(fixture);
    d.as_of = '2026-10-29T00:00:00.000Z';
    const second = repo.importEvidence(d);
    agent.activateSnapshot(second);
    agent.ask({ dataset_id: second, question: prompts[0], request_id: 'second-snapshot' });
    await supervisor.completion;
    assert.equal(agent.state().current_dataset_id, second);
    repo.importEvidence(fixture);
    agent.activateSnapshot(first);
    assert.equal(agent.state().current_dataset_id, first);
    assert.equal(new AgentExperience(store, repo, supervisor).state().current_dataset_id, first);
  } finally {
    store.close();
  }
});

test('dismissed review stays auditable but leaves the daily review-ready count', async () => {
  const { store, agent } = setup();
  try {
    await agent.seed(fixture);
    const c = agent.state().cases.find((c) => c.readiness === 'ready_for_review');
    const plan = agent.createPlan(c.id);
    agent.updatePlan(plan.id, {
      version: 1,
      status: 'dismissed',
      owner: 'Data platform',
      note: 'Producer confirms active work',
    });
    const state = agent.state();
    assert.equal(state.summary.review_ready, 1);
    assert.equal(state.cases.find((row) => row.id === c.id).review_status, 'dismissed');
    assert.equal(state.plans[0].history.length, 2);
    assert.equal(state.verified_savings_micros, null);
  } finally {
    store.close();
  }
});
