import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createServer, previewOriginFromEnv } from '../src/server.js';
async function setup(t, options = {}) {
  const server = createServer(options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let state = await (await fetch(base + '/api/state')).json();
  const send = (path, body, method = 'POST', extra = {}) => {
    if (path === '/api/investigate' && body && typeof body === 'object' && !body.request_id)
      body = { ...body, request_id: randomUUID() };
    return fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': state.csrf, ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  };
  return { base, send, state, server };
}
test('HTTP import, overview, evidence, investigation, action lifecycle and invalid requests', async (t) => {
  const { base, send } = await setup(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SYNTHETIC · OFFLINE/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const data = await (await fetch(base + '/api/sample')).json();
  const imported = await send('/api/import', { data, name: 'Test AWS data' });
  assert.equal(imported.status, 201);
  const { dataset_id } = await imported.json();
  const scope = { baseline: '2026-09', current: '2026-10' };
  const overview = await send('/api/overview', { dataset_id, scope });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).trend.length, 6);
  const res = await send('/api/investigate', {
    dataset_id,
    scope,
    question: 'Why did spend change?',
    mode: 'offline',
  });
  assert.equal(res.status, 201);
  const inv = await res.json();
  const evidence = await fetch(
    `${base}/api/evidence?dataset=${dataset_id}&ref=${encodeURIComponent(inv.findings[0].refs[0])}`,
  );
  assert.equal(evidence.status, 200);
  assert.ok((await evidence.json()).record.id);
  const action = await (
    await send('/api/actions', { investigation_id: inv.id, recommendation_index: 0 })
  ).json();
  const patch = { version: 1, status: 'in-progress', owner: 'Eswanth', note: 'Review first' };
  assert.equal((await send(`/api/actions/${action.id}`, patch, 'PATCH')).status, 200);
  assert.equal((await send(`/api/actions/${action.id}`, patch, 'PATCH')).status, 409);
  assert.equal(
    (
      await send('/api/investigate', {
        dataset_id,
        scope,
        question: 'Send my report',
        mode: 'offline',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send('/api/investigate', {
        dataset_id,
        scope,
        question: 'cost change',
        mode: 'bedrock',
      })
    ).status,
    409,
  );
  for (const body of ['{broken', 'null', '{}'])
    assert.equal((await send('/api/import', body)).status, 400);
  const bad = structuredClone(data);
  bad.usage[0].cost_micros = -1;
  assert.equal((await send('/api/import', { data: bad, name: 'invalid' })).status, 400);
  assert.equal((await (await fetch(base + '/api/state')).json()).active_dataset_id, dataset_id);
  assert.equal((await send('/api/import', ' '.repeat(2_000_001))).status, 413);
  assert.equal((await fetch(base + '/api/evidence?kind=secrets')).status, 400);
  assert.equal((await fetch(base + '/api/evidence?ref=usage:missing')).status, 404);
  assert.equal((await fetch(base + '/api/evidence?page=-1')).status, 400);
  assert.equal(
    (await send('/api/overview', { dataset_id, scope: { ...scope, run: 'command' } })).status,
    400,
  );
  assert.equal((await fetch(base + '/src/engine.js')).status, 404);
  assert.equal((await fetch(base + '/api/export?dataset=' + dataset_id)).status, 200);
});
test('API rejects CSRF, cross-origin reads/writes, unexpected hosts and unsupported methods', async (t) => {
  const { base, send } = await setup(t);
  assert.equal(
    (
      await fetch(base + '/api/clear', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await send('/api/clear', {}, 'POST', { Origin: 'https://attacker.example' })).status,
    403,
  );
  assert.equal(
    (await fetch(base + '/api/state', { headers: { Origin: 'https://attacker.example' } })).status,
    403,
  );
  assert.equal(
    (await send('/api/clear', {}, 'POST', { 'Content-Type': 'text/plain' })).status,
    415,
  );
  assert.equal((await fetch(base + '/api/state', { method: 'DELETE' })).status, 405);
  const status = await new Promise((resolve, reject) => {
    http
      .get(base + '/api/state', { headers: { Host: 'attacker.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(status, 403);
});
test('seeded workspace has useful saved investigations and provider failures do not save partial work', async (t) => {
  const { base, send, state } = await setup(t, {
    seed: true,
    modelAdapter: {
      investigate: async () => {
        throw Error('provider private detail');
      },
    },
  });
  assert.equal(state.investigations.length, 2);
  assert.equal(state.actions.length, 1);
  const response = await send('/api/investigate', {
    dataset_id: state.active_dataset_id,
    scope: {},
    question: 'cost change',
    mode: 'bedrock',
  });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('private detail'));
  assert.equal((await (await fetch(base + '/api/state')).json()).investigations.length, 2);
});

test('investigation request IDs replay one saved result and reject conflicting content', async (t) => {
  const { base, send, state } = await setup(t, { seed: true });
  const body = {
    dataset_id: state.active_dataset_id,
    scope: {},
    question: 'cost change',
    mode: 'offline',
    request_id: 'replay-request-0001',
  };
  const first = await send('/api/investigate', body);
  assert.equal(first.status, 201);
  const one = await first.json();
  const second = await send('/api/investigate', body);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).id, one.id);
  assert.equal((await send('/api/investigate', { ...body, question: 'retries' })).status, 409);
  const current = await (await fetch(base + '/api/state')).json();
  assert.equal(current.investigations.length, state.investigations.length + 1);
  for (const path of [
    '/constructor',
    '/__proto__',
    '/toString',
    '/%2e%2e/package.json',
    '/..%2fsrc%2fstore.js',
  ])
    assert.equal((await fetch(base + path)).status, 404);
});
test('duplicate in-flight model request is rejected before a second provider call', async (t) => {
  let release,
    calls = 0;
  const gate = new Promise((r) => (release = r));
  const { send, state } = await setup(t, {
    seed: true,
    modelAdapter: {
      investigate: async () => {
        calls++;
        await gate;
        throw Error('mock provider stopped');
      },
    },
  });
  const body = {
    dataset_id: state.active_dataset_id,
    scope: {},
    question: 'cost change',
    mode: 'bedrock',
    request_id: 'inflight-request-0001',
  };
  const first = send('/api/investigate', body);
  while (!calls) await new Promise((r) => setTimeout(r, 5));
  const duplicate = await send('/api/investigate', body);
  assert.equal(duplicate.status, 409);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 502);
});

test('preview configuration is exact, opt-in and fails closed', () => {
  const env = {
    CODESPACES: 'true',
    CODESPACE_NAME: 'example-workspace-abc',
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
  };
  const origin = 'https://example-workspace-abc-3000.app.github.dev';
  assert.equal(previewOriginFromEnv({}, 3000), null);
  assert.equal(previewOriginFromEnv(env, 3000), origin);
  assert.equal(previewOriginFromEnv({ TOKENOMICS_PREVIEW_ORIGIN: origin }, 3000), origin);
  for (const value of [
    '',
    '*',
    origin + '/',
    origin + '.evil.test',
    origin + ':443',
    origin.replace('https:', 'http:'),
    'https://*.app.github.dev',
    'https://example-65536.app.github.dev',
    origin + '?x=1',
    'https://user@example-3000.app.github.dev',
  ]) {
    assert.throws(() => previewOriginFromEnv({ TOKENOMICS_PREVIEW_ORIGIN: value }, 3000));
    assert.throws(() => createServer({ previewOrigin: value }));
  }
  for (const patch of [
    { CODESPACE_NAME: '../evil' },
    { CODESPACE_NAME: 'name.evil' },
    { GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'attacker.test' },
    { GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: undefined },
  ])
    assert.throws(() => previewOriginFromEnv({ ...env, ...patch }, 3000));
  for (const port of [0, 65536, NaN, 3.5]) assert.throws(() => previewOriginFromEnv(env, port));
});

test('exact preview host permits same-origin UI requests and rejects spoofing and CSRF', async (t) => {
  const origin = 'https://example-workspace-abc-3000.app.github.dev';
  const host = new URL(origin).host;
  const { base, state } = await setup(t, { previewOrigin: origin });
  const request = (path, method = 'GET', headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        base + path,
        {
          method,
          headers: { Host: host, ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : '{}');
    });
  assert.equal((await request('/')).status, 200);
  const previewState = await request('/api/state', 'GET', { Origin: origin });
  assert.equal(previewState.status, 200);
  assert.equal(JSON.parse(previewState.body).csrf, state.csrf);
  const write = {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-Workspace-Token': state.csrf,
    'Sec-Fetch-Site': 'same-origin',
  };
  assert.equal((await request('/api/clear', 'POST', write)).status, 200);
  for (const headers of [
    { ...write, Origin: 'https://attacker.test' },
    { ...write, Origin: 'null' },
    { ...write, Origin: 'http://' + host },
    { ...write, Origin: 'https://different-3000.app.github.dev' },
    { ...write, Origin: '' },
    { ...write, 'Sec-Fetch-Site': 'cross-site' },
    { ...write, 'X-Workspace-Token': 'incorrect' },
    { ...write, Host: host + '.attacker.test' },
    { ...write, Host: 'different-3000.app.github.dev' },
    { ...write, Host: 'attacker.test', 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https' },
    { ...write, Host: new URL(base).host, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https' },
  ])
    assert.equal((await request('/api/clear', 'POST', headers)).status, 403);
  assert.equal(
    (
      await request('/api/clear', 'POST', {
        'Content-Type': 'application/json',
        'X-Workspace-Token': state.csrf,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/state', 'GET', { Origin: 'https://attacker.test' })).status,
    403,
  );
  assert.equal((await request('/api/state', 'GET', { Host: host + ':443' })).status, 403);
  assert.equal(
    (await request('/api/state', 'GET', { Host: 'attacker.test', Forwarded: 'host=' + host }))
      .status,
    403,
  );
  const local = await fetch(base + '/api/state');
  assert.equal(local.status, 200);
  const unconfigured = await setup(t);
  const denied = await new Promise((resolve, reject) => {
    http
      .get(unconfigured.base + '/', { headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(denied, 403);
});
