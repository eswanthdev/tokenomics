// Optional real-browser smoke test. Requires a local Chromium executable.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const nav = async (name) => {
    await evaluate(`location.hash=${JSON.stringify('/' + name)}`);
    await wait(
      `document.querySelector('#crumb').textContent===${JSON.stringify({ brief: 'Daily brief', opportunities: 'Opportunity inbox', investigations: 'Investigations', plans: 'Review plans', coverage: 'Evidence coverage', setup: 'Connection readiness' }[name])}`,
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
  await wait(
    "document.querySelector('.brief-hero') && !document.querySelector('#error').hidden===false",
  );
  assert.match(await evaluate('document.body.innerText'), /2 opportunities/);
  assert.match(await evaluate('document.body.innerText'), /Verified savings/);
  await capture('agent-brief-desktop');
  await click('.brief-hero .btn');
  await wait("document.querySelector('.scenario-amount')");
  assert.match(await evaluate("document.querySelector('.scenario-amount').textContent"), /47.10/);
  const caseRoute = await evaluate('location.hash');
  await click('.skip');
  assert.equal(await evaluate('location.hash'), caseRoute);
  assert.equal(await evaluate('document.activeElement.id'), 'main');
  await evaluate('window.scrollTo(0,0)');
  await capture('agent-case-desktop');
  await click('[data-source]');
  await wait("document.querySelector('#evidence-dialog').open");
  assert.match(
    await evaluate("document.querySelector('#evidence-content').textContent"),
    /000000000001/,
  );
  await call(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    },
    sessionId,
  );
  await call(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    },
    sessionId,
  );
  await wait("!document.querySelector('#evidence-dialog').open");
  await click('[data-plan]');
  await wait("document.querySelector('#plan-form')");
  await evaluate(
    "document.querySelector('[name=owner]').value='Data platform';document.querySelector('[name=status]').value='awaiting_evidence';document.querySelector('[name=note]').value='Confirm producer ownership; no execution approved.';document.querySelector('#plan-form').requestSubmit()",
  );
  await wait("document.querySelector('#notice').textContent.includes('Review decision saved')");
  assert.match(await evaluate('document.body.innerText'), /Verified savings: unavailable/);
  await capture('agent-plan-desktop');
  const planHash = await evaluate('location.hash');
  await call('Page.navigate', { url: base + planHash }, sessionId);
  await wait("document.querySelector('[name=owner]')?.value==='Data platform'");
  assert.equal(await evaluate("document.querySelector('#plan-form').dataset.version"), '2');
  // Drafts survive refresh, and newer typing during our own save rebases safely.
  await evaluate(
    "document.querySelector('[name=note]').value='Unsaved draft';document.querySelector('[name=note]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#refresh').click()",
  );
  await wait("document.querySelector('[data-discard]')");
  assert.equal(await evaluate("document.querySelector('[name=note]').value"), 'Unsaved draft');
  await evaluate(
    `window.realFetch=window.fetch;window.fetch=async(u,o)=>{const response=await window.realFetch(u,o);if(String(u).startsWith('/api/agent/plans/')&&o?.method==='PATCH')return new Promise(resolve=>window.releasePlan=()=>resolve(response));return response;};document.querySelector('#plan-form').requestSubmit();`,
  );
  await wait("typeof window.releasePlan==='function'");
  await evaluate(
    "document.querySelector('[name=note]').value='Newer draft while saving';document.querySelector('[name=note]').dispatchEvent(new Event('input',{bubbles:true}));window.fetch=window.realFetch;window.releasePlan()",
  );
  await wait("document.querySelector('#plan-form').dataset.version==='3'");
  assert.equal(
    await evaluate("document.querySelector('[name=note]').value"),
    'Newer draft while saving',
  );
  await evaluate("document.querySelector('#plan-form').requestSubmit()");
  await wait("document.querySelector('#plan-form').dataset.version==='4'");
  assert.ok(await evaluate("document.querySelector('#error').hidden"));
  await nav('opportunities');
  await evaluate(
    "document.querySelector('#search').value='does-not-exist';document.querySelector('#search').dispatchEvent(new Event('input'))",
  );
  await wait("document.body.innerText.includes('No matching cases')");
  await click('[data-reset]');
  await wait("document.querySelectorAll('.inbox-row').length>0");
  await evaluate(
    "document.querySelector('#filter-service').value='s3';document.querySelector('#filter-service').dispatchEvent(new Event('change'))",
  );
  assert.ok(
    await evaluate(
      "Array.from(document.querySelectorAll('.inbox-row')).every(r=>r.innerText.includes('S3'))",
    ),
  );
  await capture('agent-inbox-desktop');
  await nav('investigations');
  await evaluate(
    "document.querySelector('#question').value='Why did spend increase?';document.querySelector('#question').dispatchEvent(new Event('input'));document.querySelector('#ask-form').requestSubmit()",
  );
  await wait(
    "document.querySelector('.gap')?.textContent.includes('cannot establish spend-change')",
  );
  await click('[data-prompt="0"]');
  await evaluate(
    "document.querySelector('#question').dispatchEvent(new Event('input'));document.querySelector('#ask-form').requestSubmit()",
  );
  await wait(
    "location.hash.startsWith('#/investigation/') && document.querySelector('.page-head .badge')?.textContent==='partial'",
  );
  assert.match(await evaluate('document.body.innerText'), /supervisor checked all three/);
  await capture('agent-investigation-desktop');
  // Background completion saves the case without hijacking later navigation.
  await nav('investigations');
  await evaluate(
    `window.realFetch=window.fetch;window.fetch=async(u,o)=>{const response=await window.realFetch(u,o);if(String(u)==='/api/agent/ask')return new Promise(resolve=>window.releaseQuestion=()=>resolve(response));return response;};document.querySelector('#question').value='Review EC2 capacity evidence';document.querySelector('#question').dispatchEvent(new Event('input'));document.querySelector('#ask-form').requestSubmit();`,
  );
  await wait("typeof window.releaseQuestion==='function'");
  await nav('coverage');
  await evaluate('window.fetch=window.realFetch;window.releaseQuestion()');
  await wait("document.querySelector('#notice').textContent==='Investigation saved.'");
  assert.equal(await evaluate('location.hash'), '#/coverage');
  await nav('coverage');
  assert.match(await evaluate('document.body.innerText'), /7 of 9/);
  assert.match(await evaluate('document.body.innerText'), /denied/);
  await capture('agent-coverage-desktop');
  await nav('setup');
  assert.match(await evaluate('document.body.innerText'), /AWS is not connected/);
  await evaluate(
    "window.savedFetch=window.fetch;window.fetch=()=>Promise.reject(Error('Test outage'));document.querySelector('#refresh').click()",
  );
  await wait("!document.querySelector('#error').hidden");
  await evaluate("window.fetch=window.savedFetch;document.querySelector('#refresh').click()");
  await wait("document.querySelector('#error').hidden");
  await nav('brief');
  await call(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'));
  assert.ok(
    await evaluate("document.querySelector('.brief-side').getBoundingClientRect().height>0"),
  );
  assert.ok(
    await evaluate("document.querySelector('.date-label').getBoundingClientRect().height>0"),
  );
  assert.ok(
    await evaluate("document.querySelector('.mobile-link').getBoundingClientRect().height>=44"),
  );
  assert.equal(await evaluate("document.querySelector('#notice').textContent"), '');
  await capture('agent-brief-mobile');
  await click('.brief-hero .btn');
  await wait("document.querySelector('.scenario-amount')");
  assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'));
  await capture('agent-case-mobile');
  await call(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    sessionId,
  );
  await call(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    sessionId,
  );
  assert.ok(
    await evaluate("document.activeElement.matches('a,button,input,textarea,select,summary')"),
  );
  const emptyServer = createServer();
  await new Promise((r) => emptyServer.listen(0, '127.0.0.1', r));
  try {
    await call(
      'Page.navigate',
      { url: `http://127.0.0.1:${emptyServer.address().port}` },
      sessionId,
    );
    await wait("document.body.innerText.includes('Explore the evidence first')");
    await click('[data-demo]');
    await wait(
      "location.hash.startsWith('#/investigation/') && document.querySelector('.page-head .badge')?.textContent==='partial'",
    );
  } finally {
    await new Promise((r) => emptyServer.close(r));
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: seeded brief, case/evidence, Escape/Tab keyboard, persisted plan, filters/empty, unsupported/compound questions, recorded timeline, coverage, setup/error recovery, desktop/mobile overflow.',
  );
} finally {
  socket?.close();
  browser.kill('SIGTERM');
  await new Promise((r) => server.close(r));
  await new Promise((r) => (browser.exitCode !== null ? r() : browser.once('exit', r)));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
