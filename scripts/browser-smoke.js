// Optional real-browser smoke test. Requires a local Chromium executable.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
const profile = await mkdtemp(join(tmpdir(), 'tokenomics-browser-'));
const server = createServer({ seed: true });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = spawn(
  process.env.CHROMIUM || '/usr/bin/chromium',
  [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(Error('Chromium did not start')), 15000);
    browser.on('error', reject);
    browser.stderr.on('data', (c) => {
      log += c;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const r = JSON.parse(e.data);
    if (pending.has(r.id)) {
      const { resolve, reject } = pending.get(r.id);
      pending.delete(r.id);
      r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result);
    }
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetInfos } = await call('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const evaluate = async (expression) => {
    const r = await call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}; ${await evaluate('document.body.innerText')}`);
  };
  await call('Runtime.enable', {}, sessionId);
  const errors = [];
  const oldHandler = socket.onmessage;
  socket.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    oldHandler(e);
  };
  await call(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const ready = () =>
    wait(
      "document.readyState === 'complete' && document.querySelector('#main').getAttribute('aria-busy') === 'false' && !!document.querySelector('.metrics')",
    );
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const nav = async (route) => {
    await evaluate(`location.hash=${JSON.stringify('/' + route)}`);
    await wait(
      `document.querySelector('#crumb').textContent===${JSON.stringify({ overview: 'Overview', investigations: 'Investigations', quality: 'Data quality', evidence: 'Evidence explorer', actions: 'Action tracker', settings: 'Workspace & history' }[route])}`,
    );
  };
  const capture = async (name) => {
    const shot = await call(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      sessionId,
    );
    await writeFile(
      new URL(`../docs/screenshots/${name}.png`, import.meta.url),
      Buffer.from(shot.data, 'base64'),
    );
  };
  await mkdir(new URL('../docs/screenshots/', import.meta.url), { recursive: true });
  await call('Page.navigate', { url: base }, sessionId);
  await ready();
  assert.match(await evaluate('document.body.innerText'), /\$422\.57/);
  assert.match(await evaluate('document.body.innerText'), /101 of 103/);
  await capture('desktop-overview');
  const select = async (key, value) => {
    await evaluate(
      `(()=>{const el=document.querySelector('[data-scope="${key}"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait("document.querySelector('#main').getAttribute('aria-busy')==='false'");
  };
  await select('account_id', '000000000001');
  assert.ok(
    !(await evaluate('document.querySelectorAll(".metric strong")[0].textContent')).includes(
      '422.57',
    ),
  );
  await select('model', 'bedrock-standard-synthetic');
  assert.equal(await evaluate('document.querySelectorAll(".metric strong")[1].textContent'), 'N/A');
  await click('#reset-filters');
  await ready();
  assert.match(
    await evaluate('document.querySelectorAll(".metric strong")[0].textContent'),
    /422\.57/,
  );
  await click('[data-refs]');
  await wait(
    "document.querySelector('#evidence-dialog').open && !!document.querySelector('#record-detail pre')",
  );
  assert.match(await evaluate("document.querySelector('#record-detail').innerText"), /cost_micros/);
  await click('[data-close="evidence-dialog"]');
  await nav('investigations');
  await click('.case-item');
  await wait("!!document.querySelector('.tool-steps')");
  await capture('desktop-investigation');
  await evaluate("document.querySelector('.finding').scrollIntoView({block:'start'})");
  await capture('desktop-investigation-findings');
  await evaluate('window.scrollTo(0,0)');
  const before = await evaluate("document.querySelectorAll('.case-item').length");
  await evaluate(
    "document.querySelector('#question').value='Delete the AWS account';document.querySelector('#ask-form').requestSubmit()",
  );
  await wait("document.querySelector('#ask-result').textContent.includes('not supported')");
  assert.equal(await evaluate("document.querySelectorAll('.case-item').length"), before);
  await evaluate(
    "document.querySelector('#question').value='Investigate retries and failures';document.querySelector('#ask-form').requestSubmit();document.querySelector('#ask-form').requestSubmit()",
  );
  await wait(
    `document.querySelectorAll('.case-item').length===${before + 1} && document.querySelector('#main').getAttribute('aria-busy')==='false'`,
  );
  assert.match(
    await evaluate("document.querySelector('.case-detail').innerText"),
    /Repeated attempt cost/,
  );
  await click('[data-track]:not(:disabled)');
  await wait("document.querySelector('#status').textContent.includes('action tracker')");
  await nav('actions');
  await evaluate(
    "(()=>{const f=document.querySelector('.action-form');f.querySelector('[name=status]').value='in-progress';f.querySelector('[name=owner]').value='Eswanth';f.querySelector('[name=note]').value='Review retry causes, preserve resolution quality.';f.requestSubmit();})()",
  );
  await wait("document.querySelector('#status').textContent.includes('audit event')");
  await call('Page.reload', {}, sessionId);
  await wait(
    "!!document.querySelector('.action-form') && document.querySelector('#main').getAttribute('aria-busy')==='false'",
  );
  assert.equal(
    await evaluate("document.querySelector('.action-form [name=owner]').value"),
    'Eswanth',
  );
  await nav('quality');
  assert.match(
    await evaluate('document.body.innerText'),
    /2 successful outcomes have no linked cost/,
  );
  await capture('desktop-quality');
  await nav('evidence');
  await wait("!!document.querySelector('.pagination')");
  await click('[data-page="1"]');
  await wait("document.querySelector('.pagination').textContent.includes('page 2')");
  await evaluate(
    "document.querySelector('#evidence-query').value='no-matching-source';document.querySelector('#evidence-search').requestSubmit()",
  );
  await wait(
    "document.querySelector('#evidence-table').textContent.includes('0 matching records')",
  );
  await nav('overview');
  await ready();
  // Deliberate local transport failure: no network/proxy or provider is involved.
  await evaluate(
    "window.originalFetch=window.fetch;window.fetch=(url,opts)=>String(url).includes('/api/overview')?Promise.reject(Error('Simulated offline transport')):window.originalFetch(url,opts)",
  );
  await select('workflow', 'support');
  await wait("!document.querySelector('#error').hidden");
  assert.match(await evaluate("document.querySelector('#error').textContent"), /Simulated offline/);
  await evaluate('window.fetch=window.originalFetch');
  await click('#retry-load');
  await ready();
  assert.equal(await evaluate("document.querySelector('#error').hidden"), true);
  await nav('settings');
  await click('#clear');
  await wait("document.querySelector('#status').textContent.includes('Active view cleared')");
  await nav('overview');
  await wait(
    "document.querySelector('#content').textContent.includes('Your evidence starts here')",
  );
  await click('#import-open');
  const upload = async (raw) =>
    evaluate(
      `(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(raw)}],'import.json',{type:'application/json'}));const input=document.querySelector('#file');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  await upload('{invalid');
  await wait("!document.querySelector('#import-error').hidden");
  assert.match(
    await evaluate("document.querySelector('#import-error').textContent"),
    /Invalid JSON/,
  );
  const fixture = await readFile(new URL('../fixtures/workbench.json', import.meta.url), 'utf8');
  await upload(fixture);
  await ready();
  assert.equal(await evaluate("document.querySelector('#import-dialog').open"), false);
  await click('#import-open');
  await click('#sample');
  await ready();
  await wait("!document.querySelector('#import-dialog').open");
  await nav('settings');
  assert.equal(await evaluate("document.querySelectorAll('#content a[download]').length"), 1);
  await nav('overview');
  await call(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await capture('mobile-overview');
  await nav('investigations');
  await click('.case-item');
  await wait("!!document.querySelector('.tool-steps')");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await capture('mobile-investigation');
  await evaluate("document.querySelector('.finding').scrollIntoView({block:'start'})");
  await capture('mobile-investigation-findings');
  await nav('quality');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  // Adversarial navigation and mutation races: delay work without changing the server.
  await nav('investigations');
  await evaluate(
    "window.reviewFetch=window.fetch;window.fetch=(url,opts)=>String(url)==='/api/investigate'?new Promise((resolve,reject)=>{window.releaseInvestigation=()=>window.reviewFetch(url,opts).then(resolve,reject);}):window.reviewFetch(url,opts)",
  );
  await evaluate(
    "document.querySelector('#question').value='Delete the account';document.querySelector('#ask-form').requestSubmit()",
  );
  await wait("typeof window.releaseInvestigation==='function'");
  await nav('quality');
  await evaluate('window.releaseInvestigation()');
  await wait("document.querySelector('#main').getAttribute('aria-busy')==='false'");
  assert.equal(await evaluate("document.querySelector('#crumb').textContent"), 'Data quality');
  assert.equal(await evaluate("document.querySelector('#error').hidden"), true);
  await evaluate('window.fetch=window.reviewFetch;delete window.releaseInvestigation');
  await nav('investigations');
  await evaluate(
    "window.fetch=(url,opts)=>String(url)==='/api/investigate'?new Promise((resolve,reject)=>{window.releaseInvestigation=()=>window.reviewFetch(url,opts).then(resolve,reject);}):window.reviewFetch(url,opts)",
  );
  await evaluate(
    "document.querySelector('#question').value='Investigate retries and failures';document.querySelector('#ask-form').requestSubmit()",
  );
  await wait("typeof window.releaseInvestigation==='function'");
  assert.equal(await evaluate("document.querySelector('[data-scope=workflow]').disabled"), true);
  await evaluate(
    "(()=>{const s=document.querySelector('[data-scope=workflow]');s.value='support';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  assert.equal(await evaluate("document.querySelector('#main').getAttribute('aria-busy')"), 'true');
  assert.equal(await evaluate("document.querySelector('#ask-form button').disabled"), true);
  await evaluate('window.releaseInvestigation()');
  await wait("document.querySelector('#main').getAttribute('aria-busy')==='false'");
  await evaluate('window.fetch=window.reviewFetch');
  const savedCount = await evaluate(
    "window.fetch('/api/state').then(r=>r.json()).then(s=>s.investigations.length)",
  );
  await evaluate(
    "window.fetch=(url,opts)=>String(url)==='/api/state'?Promise.reject(Error('Refresh-only failure')):window.reviewFetch(url,opts)",
  );
  await evaluate(
    "document.querySelector('#question').value='What does a successful workflow cost?';document.querySelector('#ask-form').requestSubmit()",
  );
  await wait(
    "!document.querySelector('#error').hidden && document.querySelector('#error').textContent.includes('Investigation saved')",
  );
  assert.equal(
    await evaluate(
      "window.reviewFetch('/api/state').then(r=>r.json()).then(s=>s.investigations.length)",
    ),
    savedCount + 1,
  );
  assert.ok(
    !(await evaluate("document.querySelector('#error').textContent")).includes(
      'No result was saved',
    ),
  );
  await evaluate('window.fetch=window.reviewFetch');
  await click('#retry-load');
  await wait("document.querySelector('#main').getAttribute('aria-busy')==='false'");
  const beforeLost = await evaluate(
    "window.fetch('/api/state').then(r=>r.json()).then(s=>s.investigations.length)",
  );
  await evaluate(
    "window.fetch=async(url,opts)=>{const r=await window.reviewFetch(url,opts);if(String(url)==='/api/investigate')throw Error('Lost response after commit');return r;}",
  );
  await evaluate(
    "document.querySelector('#question').value='Why did spend change?';document.querySelector('#ask-form').requestSubmit()",
  );
  await wait(
    "!document.querySelector('#error').hidden && document.querySelector('#error').textContent.includes('response unavailable')",
  );
  await evaluate('window.fetch=window.reviewFetch');
  await evaluate(
    "document.querySelector('#question').value='Why did spend change?';document.querySelector('#ask-form').requestSubmit()",
  );
  await wait(
    "document.querySelector('#main').getAttribute('aria-busy')==='false' && document.querySelector('#status').textContent.includes('Investigation saved')",
  );
  assert.equal(
    await evaluate("window.fetch('/api/state').then(r=>r.json()).then(s=>s.investigations.length)"),
    beforeLost + 1,
  );

  // Imported free text must render as text, even in source-record details.
  await click('#import-open');
  const hostile = JSON.parse(fixture);
  hostile.usage[0].note = '<img src=x onerror="window.injected=true">';
  await upload(JSON.stringify(hostile));
  await ready();
  await nav('evidence');
  await wait("!!document.querySelector('.pagination')");
  await evaluate(
    "document.querySelector('#evidence-query').value='onerror';document.querySelector('#evidence-search').requestSubmit()",
  );
  await wait("document.querySelector('.pagination').textContent.includes('1 matching records')");
  await click('#evidence-table [data-refs]');
  await wait("!!document.querySelector('#record-detail pre')");
  assert.equal(await evaluate('window.injected===undefined'), true);
  assert.equal(await evaluate("document.querySelector('#record-detail img')===null"), true);
  assert.match(
    await evaluate("document.querySelector('#record-detail pre').textContent"),
    /onerror/,
  );
  await click('[data-close="evidence-dialog"]');
  // A committed dataset change with a failed refresh must never display the old report as current.
  await click('#import-open');
  await evaluate(
    "window.fetch=(url,opts)=>String(url)==='/api/state'?Promise.reject(Error('Dataset refresh failure')):window.reviewFetch(url,opts)",
  );
  const legacy = await readFile(new URL('../fixtures/support.json', import.meta.url), 'utf8');
  await upload(legacy);
  await wait(
    "document.querySelector('#content').textContent.includes('Refresh required') && document.querySelector('#main').getAttribute('aria-busy')==='false'",
  );
  assert.equal(await evaluate("document.querySelector('.metrics')===null"), true);
  assert.equal(await evaluate("document.querySelector('#error').hidden"), false);
  await evaluate('window.fetch=window.reviewFetch');
  await click('[data-reload]');
  await ready();
  assert.match(await evaluate("document.querySelector('.metric strong').textContent"), /168\.00/);
  await evaluate(
    "window.fetch('/api/state').then(r=>r.json()).then(s=>window.legacyDatasetId=s.active_dataset_id)",
  );
  await nav('settings');
  await evaluate(
    "window.fetch=(url,opts)=>String(url)==='/api/state'?Promise.reject(Error('Clear refresh failure')):window.reviewFetch(url,opts)",
  );
  await click('#clear');
  await wait(
    "document.querySelector('#content').textContent.includes('Refresh required') && document.querySelector('#main').getAttribute('aria-busy')==='false'",
  );
  await nav('overview');
  assert.equal(await evaluate("document.querySelector('.metrics')===null"), true);
  await evaluate('window.fetch=window.reviewFetch');
  await click('[data-reload]');
  await wait(
    "document.querySelector('#content').textContent.includes('Your evidence starts here')",
  );
  await nav('settings');
  await evaluate(
    "window.fetch=(url,opts)=>String(url)==='/api/state'?Promise.reject(Error('Activation refresh failure')):window.reviewFetch(url,opts);document.querySelector('[data-activate=\"'+window.legacyDatasetId+'\"]').click()",
  );
  await wait(
    "document.querySelector('#content').textContent.includes('Refresh required') && document.querySelector('#main').getAttribute('aria-busy')==='false'",
  );
  await evaluate('window.fetch=window.reviewFetch');
  await click('[data-reload]');
  await wait("document.querySelector('#main').getAttribute('aria-busy')==='false'");
  await nav('overview');
  assert.match(await evaluate("document.querySelector('.metric strong').textContent"), /168\.00/);

  assert.deepEqual(errors, []);
  console.log(
    'PASS: seeded dashboard, dimensional filters, exact evidence, saved investigation, unsupported/repeated requests, action update/reload, quality, evidence pagination/search, network error/recovery, empty view, invalid/valid/repeated import, and mobile navigation. No uncaught browser exceptions. Screenshots: docs/screenshots/',
  );
} finally {
  socket?.close();
  browser.kill('SIGTERM');
  await new Promise((r) => server.close(r));
  await new Promise((r) => (browser.exitCode !== null ? r() : browser.once('exit', r)));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
