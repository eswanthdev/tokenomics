import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ConflictError } from '../src/store.js';
import { runInvestigation } from '../src/workbench.js';
const fixture = JSON.parse(await readFile(new URL('../fixtures/workbench.json', import.meta.url)));
const scope = { baseline: '2026-09', current: '2026-10' };
test('datasets, investigations, actions and audit persist across close/reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenomics-store-')),
    file = join(dir, 'db.sqlite');
  let store = new Store(file);
  try {
    const id = store.import(fixture, 'Example');
    const inv = store.saveInvestigation(
      id,
      runInvestigation(fixture, scope, 'Why did spend change?'),
    );
    const a = store.addAction(inv.id, 0);
    const updated = store.updateAction(a.id, {
      version: 1,
      status: 'in-progress',
      owner: 'Eswanth',
      note: 'Review model routing with support quality data.',
    });
    assert.equal(updated.version, 2);
    const auditCount = store.audit().length;
    store.close();
    store = new Store(file);
    assert.equal(store.activeId(), id);
    assert.equal(store.investigation(inv.id).dataset_id, id);
    assert.equal(store.actions()[0].owner, 'Eswanth');
    assert.equal(store.audit().length, auditCount);
    const alternate = structuredClone(fixture);
    alternate.usage[0].note = 'another immutable version';
    const second = store.import(alternate, 'Second');
    assert.notEqual(second, id);
    assert.deepEqual(store.dataset(id), fixture);
    store.clearActive();
    assert.equal(store.activeId(), null);
    assert.ok(store.investigation(inv.id));
    store.activate(id);
    assert.equal(store.activeId(), id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('failed validation, stale writes and bad references do not partially mutate state', () => {
  const store = new Store();
  try {
    const id = store.import(fixture, 'Example'),
      inv = store.saveInvestigation(
        id,
        runInvestigation(fixture, scope, 'What does a successful workflow cost?'),
      ),
      a = store.addAction(inv.id, 0);
    assert.equal(store.addAction(inv.id, 0).id, a.id);
    assert.equal(store.actions().length, 1);
    store.updateAction(a.id, {
      version: 1,
      status: 'done',
      owner: 'A',
      note: 'Manual review completed; no savings claim.',
    });
    const before = store.audit().length;
    assert.throws(
      () => store.updateAction(a.id, { version: 1, status: 'dismissed', owner: 'B', note: '' }),
      ConflictError,
    );
    assert.equal(store.audit().length, before);
    assert.equal(store.actions()[0].status, 'done');
    const bad = structuredClone(fixture);
    bad.usage[0].cost_micros = -1;
    assert.throws(() => store.import(bad));
    assert.equal(store.activeId(), id);
    assert.equal(store.datasets().length, 1);
    const broken = structuredClone(inv);
    broken.findings[0].refs = ['usage:invented'];
    assert.throws(() => store.saveInvestigation(id, broken), /unknown evidence/);
    assert.equal(store.investigations().length, 1);
    assert.throws(() =>
      store.updateAction(a.id, {
        version: 2,
        status: 'done',
        owner: 'A',
        note: '',
        command: 'deploy',
      }),
    );
  } finally {
    store.close();
  }
});
test('identical imports deduplicate and SQL-like names remain plain data', () => {
  const store = new Store();
  try {
    const id = store.import(fixture, "'; DROP TABLE datasets; --");
    assert.equal(store.import(fixture, 'same'), id);
    assert.equal(store.datasets().length, 1);
    assert.ok(store.dataset(id));
  } finally {
    store.close();
  }
});

test('request receipts survive restart and replay without another audit event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenomics-receipt-')),
    path = join(dir, 'db.sqlite');
  let store = new Store(path);
  try {
    const id = store.import(fixture, 'Example'),
      result = runInvestigation(fixture, scope, 'cost change'),
      receipt = { request_id: 'replay-after-restart', fingerprint: 'fixed-test-fingerprint' };
    const saved = store.saveInvestigation(id, result, receipt),
      events = store.audit().length;
    store.close();
    store = new Store(path);
    assert.equal(store.saveInvestigation(id, result, receipt).id, saved.id);
    assert.equal(store.audit().length, events);
    assert.equal(store.investigations().length, 1);
    assert.throws(() => store.investigationRequest(receipt.request_id, 'different'), ConflictError);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('action creation rechecks under transaction after another connection creates it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenomics-action-race-')),
    path = join(dir, 'db.sqlite');
  const a = new Store(path),
    b = new Store(path);
  try {
    const id = a.import(fixture, 'Example'),
      inv = a.saveInvestigation(id, runInvestigation(fixture, scope, 'cost change'));
    const original = a.transaction.bind(a);
    let other;
    a.transaction = (fn) => {
      other = b.addAction(inv.id, 0);
      return original(fn);
    };
    const result = a.addAction(inv.id, 0);
    assert.equal(result.id, other.id);
    assert.equal(a.actions().length, 1);
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('receipt, investigation and audit roll back together on write failure', () => {
  const store = new Store();
  try {
    const id = store.import(fixture, 'Example'),
      before = store.audit().length,
      original = store.log.bind(store),
      receipt = { request_id: 'rollback-request', fingerprint: 'same' };
    store.log = (event, ...args) => {
      if (event === 'investigation.saved') throw Error('Injected audit write failure');
      return original(event, ...args);
    };
    assert.throws(
      () => store.saveInvestigation(id, runInvestigation(fixture, scope, 'cost change'), receipt),
      /Injected/,
    );
    assert.equal(store.investigations().length, 0);
    assert.equal(store.investigationRequest(receipt.request_id, receipt.fingerprint), null);
    assert.equal(store.audit().length, before);
  } finally {
    store.close();
  }
});
test('version-one database upgrade is additive and newer versions fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenomics-migration-')),
    path = join(dir, 'db.sqlite');
  let store = new Store(path);
  try {
    const id = store.import(fixture, 'Preserved');
    store.db.exec('DROP TABLE investigation_requests; PRAGMA user_version=1;');
    store.close();
    store = new Store(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(store.dataset(id), fixture);
    store.db.exec('PRAGMA user_version=99;');
    store.close();
    store = null;
    assert.throws(() => new Store(path), /newer/);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
