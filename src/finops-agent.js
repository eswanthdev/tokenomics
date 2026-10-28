import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { ValidationError } from './engine.js';
import { ConflictError } from './store.js';
import { validateEvidence, digest, catalog, catalogVersion, assessTask } from './finops-rules.js';
// Storage port: importEvidence/evidence/listEvidence/createRun/run/listRuns/updateRun/recover.
// SQLite is the local adapter; domain workers never receive SQL/database handles.
export class FinopsRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS resource_evidence(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS finops_runs(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  importEvidence(data) {
    validateEvidence(data);
    const id = digest(data);
    this.store.transaction(() => {
      if (!this.evidence(id) && this.listEvidence().length >= 30)
        throw new ValidationError('Resource evidence snapshot limit (30) reached.');
      if (!this.evidence(id))
        this.store.log('resource_evidence.imported', id, {
          as_of: data.as_of,
          resources: data.resources.length,
        });
      this.db
        .prepare('INSERT OR IGNORE INTO resource_evidence VALUES(?,?)')
        .run(id, JSON.stringify(data));
    });
    return id;
  }
  evidence(id) {
    const r = this.db.prepare('SELECT body FROM resource_evidence WHERE id=?').get(id);
    return r ? JSON.parse(r.body) : null;
  }
  listEvidence() {
    return this.db
      .prepare('SELECT id,body FROM resource_evidence ORDER BY rowid DESC')
      .all()
      .map((r) => ({ id: r.id, as_of: JSON.parse(r.body).as_of }));
  }
  createRun(requestId, datasetId) {
    const fingerprint = digest({ datasetId, catalogVersion });
    return this.store.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM finops_runs WHERE request_id=?').get(requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ConflictError('Request ID belongs to another snapshot/catalog.');
        return { run: JSON.parse(prior.body), created: false };
      }
      if (this.listRuns().length >= 200)
        throw new ValidationError('FinOps run limit (200) reached.');
      const run = {
        id: randomUUID(),
        request_id: requestId,
        dataset_id: datasetId,
        catalog_version: catalogVersion,
        catalog_snapshot: structuredClone(catalog),
        mode: 'deterministic-specialists',
        state: 'pending',
        created_at: new Date().toISOString(),
        steps: [],
        findings: [],
        error: null,
      };
      this.db
        .prepare('INSERT INTO finops_runs VALUES(?,?,?,?)')
        .run(run.id, requestId, fingerprint, JSON.stringify(run));
      this.store.log('finops.requested', run.id, { dataset_id: datasetId });
      return { run, created: true };
    });
  }
  run(id) {
    const r = this.db.prepare('SELECT body FROM finops_runs WHERE id=?').get(id);
    return r ? JSON.parse(r.body) : null;
  }
  listRuns() {
    return this.db
      .prepare('SELECT body FROM finops_runs ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.body));
  }
  updateRun(run) {
    this.store.transaction(() => {
      this.db.prepare('UPDATE finops_runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id);
      this.store.log('finops.transition', run.id, {
        state: run.state,
        completed_tasks: run.steps.length,
      });
    });
  }
  recover() {
    for (const r of this.listRuns())
      if (['pending', 'running'].includes(r.state))
        this.updateRun({
          ...r,
          state: 'interrupted',
          error:
            'Process restarted before publication. No partial findings published. Start a new request to rerun.',
          findings: [],
        });
  }
}
export function verifyWorkerResult(data, task, result) {
  // Recompute from immutable evidence; workers cannot fabricate amounts, refs or statuses.
  const expected = assessTask(data, task);
  if (digest(result) !== digest(expected))
    throw new ValidationError('Worker result failed deterministic evidence verification.');
  return result;
}
export class FinopsSupervisor {
  constructor(repository, { maxTasks = 60, deadlineMs = 10000 } = {}) {
    this.repository = repository;
    this.maxTasks = maxTasks;
    this.deadlineMs = deadlineMs;
    this.active = null;
    this.storageError = null;
    repository.recover();
  }
  start(datasetId, requestId) {
    if (this.storageError) throw new ConflictError(this.storageError);
    if (
      typeof datasetId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(datasetId) ||
      typeof requestId !== 'string' ||
      !/^[\w-]{8,100}$/.test(requestId)
    )
      throw new ValidationError('A snapshot ID and 8–100 character request ID are required.');
    const data = this.repository.evidence(datasetId);
    if (!data) throw new ValidationError('Unknown resource evidence snapshot.');
    validateEvidence(data);
    const existing = this.repository.listRuns().find((r) => r.request_id === requestId);
    if (this.active && !existing)
      throw new ConflictError('One assessment is active. Wait or cancel before starting another.');
    const { run, created } = this.repository.createRun(requestId, datasetId);
    if (created) {
      const controller = new AbortController();
      this.active = { id: run.id, controller };
      this.completion = this.execute(run, data, controller.signal)
        .catch(() => {
          this.storageError =
            'Assessment persistence failed. Saved state may be incomplete; repair storage and restart before another run.';
        })
        .finally(() => {
          this.active = null;
        });
    }
    return run;
  }
  cancel(id) {
    const run = this.repository.run(id);
    if (!run) throw new ValidationError('Unknown run.');
    if (this.active?.id === id) this.active.controller.abort();
    return run;
  }
  async execute(run, data, signal) {
    const tasks = data.scopes.flatMap((s) =>
      catalog.map((rule) => ({
        rule_id: rule.id,
        scope: { account_id: s.account_id, region: s.region },
        dataset_id: run.dataset_id,
      })),
    );
    const findings = [];
    const started = Date.now();
    try {
      if (tasks.length > this.maxTasks) throw new ValidationError('Task budget exceeded.');
      run.state = 'running';
      this.repository.updateRun(run);
      // Serial bounded dispatch is deliberate: CPU tools do not gain parallelism from promises.
      // One task per rule/account/Region; no recursive delegation or provider transport.
      for (const task of tasks) {
        await yieldTurn();
        if (signal.aborted) {
          run.state = 'cancelled';
          break;
        }
        if (Date.now() - started > this.deadlineMs)
          throw new ValidationError('Assessment deadline exceeded.');
        const result = verifyWorkerResult(data, task, assessTask(data, task));
        findings.push(...result);
        run.steps.push({
          task_id: digest(task),
          worker: catalog.find((r) => r.id === task.rule_id).service,
          rule_id: task.rule_id,
          scope: task.scope,
          state: 'verified',
          finding_count: result.length,
        });
        this.repository.updateRun(run);
      }
      if (run.state !== 'cancelled') {
        if (new Set(findings.map((r) => r.id)).size !== findings.length)
          throw new ValidationError('Duplicate finding identity.');
        run.findings = findings;
        run.state = findings.some((f) => f.status === 'insufficient_evidence')
          ? 'partial'
          : 'completed';
      }
    } catch (error) {
      run.state = 'failed';
      run.error =
        error instanceof ValidationError
          ? error.message
          : 'Assessment failed; no findings published.';
      run.findings = [];
    }
    run.finished_at = new Date().toISOString();
    this.repository.updateRun(run);
  }
}
