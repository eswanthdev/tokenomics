import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validate, ValidationError } from './engine.js';
import { evidenceIndex } from './workbench.js';
export class ConflictError extends Error {}
const now = () => new Date().toISOString();
const decode = (row) => (row ? JSON.parse(row.body) : null);
export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) {
      this.db.close();
      throw new Error('Database version is newer than this application.');
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id), version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS investigation_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, investigation_id TEXT NOT NULL REFERENCES investigations(id));
      PRAGMA user_version=2;`);
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  log(event, target, body = {}) {
    this.db
      .prepare('INSERT INTO audit(at,event,target,body) VALUES(?,?,?,?)')
      .run(now(), event, target, JSON.stringify(body));
  }
  activeId() {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key='active_dataset'").get()?.value || null
    );
  }
  datasets() {
    return this.db
      .prepare('SELECT id,name,created_at FROM datasets ORDER BY created_at DESC, id')
      .all();
  }
  dataset(id = this.activeId()) {
    return decode(this.db.prepare('SELECT body FROM datasets WHERE id=?').get(id || ''));
  }
  import(data, name = 'Imported synthetic dataset') {
    validate(data);
    if (typeof name !== 'string' || !name.trim() || name.length > 100)
      throw new ValidationError('Dataset name must be 1–100 characters.');
    const body = JSON.stringify(data),
      id = createHash('sha256').update(body).digest('hex');
    this.transaction(() => {
      const exists = this.db.prepare('SELECT id FROM datasets WHERE id=?').get(id);
      if (!exists) {
        if (this.datasets().length >= 30)
          throw new ValidationError(
            'Local dataset limit (30) reached. Export and archive this workspace before adding more.',
          );
        this.db.prepare('INSERT INTO datasets VALUES(?,?,?,?)').run(id, name, now(), body);
        this.log('dataset.imported', id, { name, usage_records: data.usage.length });
      }
      this.db
        .prepare(
          "INSERT INTO settings VALUES('active_dataset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(id);
      this.log('dataset.activated', id, { deduplicated: Boolean(exists) });
    });
    return id;
  }
  activate(id) {
    if (!this.dataset(id)) throw new ValidationError('Dataset does not exist.');
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO settings VALUES('active_dataset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(id);
      this.log('dataset.activated', id);
    });
  }
  clearActive() {
    this.transaction(() => {
      this.db.prepare("DELETE FROM settings WHERE key='active_dataset'").run();
      this.log('workspace.cleared', 'workspace', {
        retained: 'Saved datasets and investigations retained.',
      });
    });
  }
  investigations() {
    return this.db
      .prepare('SELECT body FROM investigations ORDER BY created_at DESC, id')
      .all()
      .map(decode);
  }
  investigation(id) {
    return decode(this.db.prepare('SELECT body FROM investigations WHERE id=?').get(id));
  }
  investigationRequest(request_id, fingerprint) {
    const row = this.db
      .prepare('SELECT * FROM investigation_requests WHERE request_id=?')
      .get(request_id);
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new ConflictError('This request ID was already used for a different investigation.');
    return this.investigation(row.investigation_id);
  }
  saveInvestigation(dataset_id, result, receipt = null) {
    const data = this.dataset(dataset_id);
    if (!data || !result.supported)
      throw new ValidationError(
        'Only supported investigations with an existing dataset can be saved.',
      );
    const index = evidenceIndex(data);
    for (const f of [...result.findings, ...result.recommendations])
      if (!Array.isArray(f.refs) || f.refs.some((r) => !Object.hasOwn(index, r)))
        throw new ValidationError('Investigation contains an unknown evidence reference.');
    const saved = { ...result, id: randomUUID(), dataset_id, created_at: now() };
    return this.transaction(() => {
      if (receipt) {
        const prior = this.investigationRequest(receipt.request_id, receipt.fingerprint);
        if (prior) return prior;
      }
      if (this.investigations().length >= 200)
        throw new ValidationError('Local investigation limit (200) reached.');
      this.db
        .prepare('INSERT INTO investigations VALUES(?,?,?,?)')
        .run(saved.id, dataset_id, saved.created_at, JSON.stringify(saved));
      if (receipt)
        this.db
          .prepare('INSERT INTO investigation_requests VALUES(?,?,?)')
          .run(receipt.request_id, receipt.fingerprint, saved.id);
      this.log('investigation.saved', saved.id, {
        dataset_id,
        mode: result.mode,
        question: result.question,
      });
      return saved;
    });
  }
  actions() {
    return this.db.prepare('SELECT body FROM actions ORDER BY rowid DESC').all().map(decode);
  }
  addAction(investigationId, recommendationIndex) {
    const inv = this.investigation(investigationId);
    if (!inv || !Number.isInteger(recommendationIndex) || !inv.recommendations[recommendationIndex])
      throw new ValidationError('Choose an existing investigation recommendation.');
    const existing = this.actions().find(
      (a) =>
        a.investigation_id === investigationId && a.recommendation_index === recommendationIndex,
    );
    if (existing) return existing;
    const action = {
      ...inv.recommendations[recommendationIndex],
      id: randomUUID(),
      investigation_id: investigationId,
      dataset_id: inv.dataset_id,
      recommendation_index: recommendationIndex,
      status: 'proposed',
      owner: '',
      note: '',
      version: 1,
      created_at: now(),
      updated_at: now(),
    };
    return this.transaction(() => {
      const prior = this.actions().find(
        (a) =>
          a.investigation_id === investigationId && a.recommendation_index === recommendationIndex,
      );
      if (prior) return prior;
      this.db
        .prepare('INSERT INTO actions VALUES(?,?,?,?)')
        .run(action.id, investigationId, 1, JSON.stringify(action));
      this.log('action.created', action.id, {
        investigation_id: investigationId,
        status: 'proposed',
      });
      return action;
    });
  }
  updateAction(id, patch) {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some((k) => !['version', 'status', 'owner', 'note'].includes(k))
    )
      throw new ValidationError('Invalid action fields.');
    if (
      !Number.isInteger(patch.version) ||
      !['proposed', 'in-progress', 'done', 'dismissed'].includes(patch.status) ||
      typeof patch.owner !== 'string' ||
      patch.owner.length > 80 ||
      typeof patch.note !== 'string' ||
      patch.note.length > 1000
    )
      throw new ValidationError(
        'Action requires version, valid status, owner (≤80), and note (≤1000).',
      );
    return this.transaction(() => {
      const old = decode(this.db.prepare('SELECT body FROM actions WHERE id=?').get(id));
      if (!old) throw new ValidationError('Action not found.');
      if (old.version !== patch.version)
        throw new ConflictError('This action changed in another view. Reload before saving.');
      const action = { ...old, ...patch, version: old.version + 1, updated_at: now() };
      this.db
        .prepare('UPDATE actions SET version=?,body=? WHERE id=?')
        .run(action.version, JSON.stringify(action), id);
      this.log('action.updated', id, {
        before: { status: old.status, owner: old.owner, note: old.note },
        after: { status: action.status, owner: action.owner, note: action.note },
        version: action.version,
      });
      return action;
    });
  }
  audit() {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY sequence DESC LIMIT 500')
      .all()
      .map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }
  state() {
    return {
      active_dataset_id: this.activeId(),
      datasets: this.datasets(),
      investigations: this.investigations(),
      actions: this.actions(),
      audit: this.audit(),
    };
  }
}
