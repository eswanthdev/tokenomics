import { randomUUID } from 'node:crypto';
import { ValidationError } from './engine.js';
import { ConflictError } from './store.js';
import { catalog, digest, services, scopeKey } from './finops-rules.js';
export const prompts = [
  'Prioritize EC2, S3 and CloudTrail review candidates and explain their blockers',
  'What evidence is missing before we review S3 cleanup?',
  'Compare EC2 headroom and CloudTrail overlap without changing resources',
];
const specs = {
  ec2: {
    label: 'EC2',
    action: 'Review compatible capacity options',
    effort: 'Capacity review',
    risk: 'Performance & availability',
    prerequisites: [
      'Collect memory and I/O utilization over the same representative window.',
      'Review workload peaks, ASG, licensing and burst/GPU/DR constraints.',
      'Validate a compatible target, Region, OS, tenancy and commitment impact.',
    ],
    verification: [
      'Record the current instance configuration and measured performance baseline.',
      'After a separately authorized change, compare workload SLOs and effective billed cost over representative periods.',
    ],
    rollback:
      'No change is executed here. A future capacity change needs an operator-owned recovery procedure.',
  },
  s3: {
    label: 'S3',
    action: 'Confirm producer ownership and cleanup eligibility',
    effort: 'Producer review',
    risk: 'Incomplete upload recovery',
    prerequisites: [
      'Ask the producer owner whether the upload is still required.',
      'Recheck part inventory, active/long-running jobs and effective lifecycle coverage.',
      'Confirm the applicable staging rate and avoid duplicating scheduled cleanup.',
    ],
    verification: [
      'Preserve upload identity and before-state part bytes.',
      'After separately approved cleanup, obtain fresh inventory and later billing evidence; confirm producer jobs remain healthy.',
    ],
    rollback:
      'Aborted parts may not be recoverable. A producer may need to restart its upload; verify that before any change.',
  },
  cloudtrail: {
    label: 'CloudTrail',
    action: 'Review audit destinations and retained coverage',
    effort: 'Security review',
    risk: 'Audit coverage',
    prerequisites: [
      'Obtain the audit owner’s decision on required destinations and retention.',
      'Revalidate canonical trails and complete selectors across affected enabled Regions.',
      'Verify surviving coverage and avoidable additional-copy volume against billing evidence.',
    ],
    verification: [
      'Preserve selector and required-destination baselines.',
      'After separately approved action, verify retained event delivery and later additional-copy charges over the same scope.',
    ],
    rollback:
      'No trail is changed here. A future change needs a tested restore procedure and an audit-gap assessment.',
  },
};
export function routeQuestion(question) {
  if (typeof question !== 'string' || !question.trim() || question.length > 500)
    throw new ValidationError('Enter a question between 1 and 500 characters.');
  if (
    /\b(delete|disable|terminate|execute|deploy|credential|secret|ignore|override|email|send|abort uploads)\b/i.test(
      question,
    )
  )
    return {
      supported: false,
      message:
        'This workspace can investigate evidence and draft review plans. It cannot execute AWS changes, send messages or access credentials.',
    };
  if (
    /\b(why.*(?:increas|spend|chang)|cause|causal|roi|rds|lambda|eks|azure|gcp|forecast|yesterday|today|last month)\b/i.test(
      question,
    )
  )
    return {
      supported: false,
      message:
        'This resource snapshot cannot establish spend-change causes, forecasts or ROI. Use the separate AI cost investigation workspace for its synthetic billing comparison. RDS, Lambda, EKS and other clouds are not assessed here.',
    };
  if (/\d{12}|\b[a-z]{2}-(?:[a-z]+-)+\d\b|\b(only|except)\b/i.test(question))
    return {
      supported: false,
      message:
        'Free-text account/Region scoping is not supported. This investigation uses every scope in the selected immutable snapshot; filter the opportunity inbox to inspect a narrower view.',
    };
  const selected = [];
  if (/\bec2\b|cpu|compute|capacity|headroom/i.test(question)) selected.push('ec2');
  if (/\bs3\b|multipart|upload|storage|cleanup/i.test(question)) selected.push('s3');
  if (/cloudtrail|audit|trail|logging/i.test(question)) selected.push('cloudtrail');
  if (!selected.length && /prioriti|review|opportunit|blocker|evidence|saving/i.test(question))
    selected.push(...services);
  return selected.length
    ? { supported: true, services: selected }
    : {
        supported: false,
        message:
          'Ask about EC2 low CPU, S3 multipart storage, CloudTrail management-copy overlap, or their evidence and review prerequisites. Arbitrary conversational answers are not available in deterministic mode.',
      };
}
export class AgentExperience {
  constructor(store, repository, supervisor) {
    this.store = store;
    this.repo = repository;
    this.supervisor = supervisor;
    this.db = store.db;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS agent_questions(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_plans(id TEXT PRIMARY KEY,case_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);`);
  }
  async seed(data) {
    if (this.repo.listEvidence().length) return;
    const dataset = this.repo.importEvidence(data);
    this.activateSnapshot(dataset);
    const asked = this.ask({
      dataset_id: dataset,
      question: prompts[0],
      request_id: 'seed-agent-brief-v1',
    });
    if (asked.supported) await this.supervisor.completion;
  }
  activateSnapshot(id) {
    if (!this.repo.evidence(id)) throw new ValidationError('Unknown snapshot.');
    this.store.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO settings VALUES('agent_active_snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(id);
      this.store.log('agent.snapshot_selected', id);
    });
  }
  questions() {
    return this.db
      .prepare('SELECT body FROM agent_questions ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.body));
  }
  plans() {
    return this.db
      .prepare('SELECT body FROM agent_plans ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.body));
  }
  ask({ dataset_id, question, request_id }) {
    const route = routeQuestion(question);
    if (!route.supported) return { ...route, suggestions: prompts };
    if (typeof request_id !== 'string' || !/^[\w-]{8,100}$/.test(request_id))
      throw new ValidationError('A valid request ID is required.');
    const fingerprint = digest({ dataset_id, question });
    const prior = this.db
      .prepare('SELECT * FROM agent_questions WHERE request_id=?')
      .get(request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ConflictError('This question request ID was used with different content.');
      return { supported: true, ...JSON.parse(prior.body) };
    }
    if (this.questions().length >= 200)
      throw new ValidationError('Saved investigation limit (200) reached.');
    // Start uses its own durable receipt. If the question save fails, retry reuses the run.
    const run = this.supervisor.start(
      dataset_id,
      'question-' + digest({ request_id, fingerprint }),
    );
    const saved = {
      id: randomUUID(),
      request_id,
      question,
      dataset_id,
      run_id: run.id,
      services: route.services,
      created_at: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.db
        .prepare('INSERT INTO agent_questions VALUES(?,?,?,?)')
        .run(saved.id, request_id, fingerprint, JSON.stringify(saved));
      this.store.log('agent.question_saved', saved.id, {
        run_id: run.id,
        services: route.services,
      });
    });
    return { supported: true, ...saved };
  }
  cases() {
    const datasets = new Map();
    const plans = this.plans();
    const output = new Map();
    for (const run of this.repo.listRuns()) {
      if (!['completed', 'partial'].includes(run.state)) continue;
      if (!datasets.has(run.dataset_id))
        datasets.set(run.dataset_id, this.repo.evidence(run.dataset_id));
      const data = datasets.get(run.dataset_id);
      if (!data) continue;
      for (const f of run.findings) {
        if (f.status === 'no_finding' || output.has(f.id)) continue;
        const rule = catalog.find((r) => r.id === f.rule_id),
          service = rule.service;
        const r = data.resources.find((x) => x.id === f.resource_id),
          spec = specs[service];
        const readiness =
          f.status === 'review' && f.savings.status === 'gross_opportunity'
            ? 'ready_for_review'
            : f.status === 'excluded' || f.status === 'pending_cleanup'
              ? 'policy_blocked'
              : 'needs_evidence';
        output.set(f.id, {
          id: f.id,
          review_status: plans.find((p) => p.case_id === f.id)?.status || 'not_started',
          run_id: run.id,
          dataset_id: f.dataset_id,
          service,
          service_label: spec.label,
          title:
            (typeof r?.display_name === 'string' ? r.display_name.slice(0, 140) : '') ||
            `${spec.label} · ${f.status === 'insufficient_evidence' ? 'coverage needs attention' : f.resource_id || 'scope assessment'}`,
          team: typeof r?.team === 'string' ? r.team.slice(0, 80) : 'Unassigned',
          readiness,
          priority_reason:
            readiness === 'ready_for_review'
              ? 'Quantified scenario with evidence; human eligibility review remains required.'
              : readiness === 'needs_evidence'
                ? 'Resolve the evidence gap before considering a change.'
                : 'An exclusion or existing cleanup policy prevents a new action.',
          ...spec,
          finding: f,
        });
      }
    }
    const rank = { ready_for_review: 0, needs_evidence: 1, policy_blocked: 2 };
    return [...output.values()].sort(
      (a, b) =>
        rank[a.readiness] - rank[b.readiness] ||
        ['s3', 'ec2', 'cloudtrail'].indexOf(a.service) -
          ['s3', 'ec2', 'cloudtrail'].indexOf(b.service) ||
        a.title.localeCompare(b.title),
    );
  }
  createPlan(caseId) {
    const c = this.cases().find((c) => c.id === caseId);
    if (!c) throw new ValidationError('Choose a verified case.');
    if (c.readiness === 'policy_blocked')
      throw new ValidationError(
        'This case is policy-blocked; resolve its exclusion or existing cleanup before proposing another action.',
      );
    return this.store.transaction(() => {
      const prior = this.db.prepare('SELECT body FROM agent_plans WHERE case_id=?').get(caseId);
      if (prior) return JSON.parse(prior.body);
      if (this.plans().length >= 200) throw new ValidationError('Review plan limit (200) reached.');
      const at = new Date().toISOString();
      const plan = {
        id: randomUUID(),
        case_id: caseId,
        dataset_id: c.dataset_id,
        rule_id: c.finding.rule_id,
        title: c.action,
        status: 'draft',
        owner: '',
        note: '',
        version: 1,
        created_at: at,
        updated_at: at,
        baseline: {
          as_of: c.finding.as_of,
          resource_id: c.finding.resource_id,
          refs: c.finding.refs,
          metrics: c.finding.metrics || {},
          gross_scenario: c.finding.savings,
        },
        prerequisites: c.prerequisites,
        verification: c.verification,
        rollback: c.rollback,
        verified_savings_micros: null,
        history: [{ at, event: 'Review plan created', status: 'draft', owner: '', note: '' }],
      };
      this.db
        .prepare('INSERT INTO agent_plans VALUES(?,?,?)')
        .run(plan.id, caseId, JSON.stringify(plan));
      this.store.log('agent.plan_created', plan.id, { case_id: caseId });
      return plan;
    });
  }
  updatePlan(id, patch) {
    if (
      !patch ||
      Object.keys(patch).some((k) => !['version', 'status', 'owner', 'note'].includes(k)) ||
      !Number.isInteger(patch.version) ||
      !['draft', 'in_review', 'awaiting_evidence', 'dismissed'].includes(patch.status) ||
      typeof patch.owner !== 'string' ||
      patch.owner.length > 80 ||
      typeof patch.note !== 'string' ||
      patch.note.length > 1000
    )
      throw new ValidationError(
        'Use version, review status, owner (80 chars) and note (1000 chars). Verification cannot be claimed by status.',
      );
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT body FROM agent_plans WHERE id=?').get(id);
      if (!row) throw new ValidationError('Plan not found.');
      const old = JSON.parse(row.body);
      if (old.version !== patch.version)
        throw new ConflictError('This plan changed. Reload before saving.');
      if (old.history.length >= 100) throw new ValidationError('Plan history limit reached.');
      const at = new Date().toISOString(),
        plan = {
          ...old,
          ...patch,
          version: old.version + 1,
          updated_at: at,
          history: [
            ...old.history,
            {
              at,
              event: 'Review decision recorded',
              status: patch.status,
              owner: patch.owner,
              note: patch.note,
            },
          ],
        };
      this.db.prepare('UPDATE agent_plans SET body=? WHERE id=?').run(JSON.stringify(plan), id);
      this.store.log('agent.plan_updated', id, { version: plan.version, status: plan.status });
      return plan;
    });
  }
  state() {
    const snapshots = this.repo.listEvidence(),
      runs = this.repo.listRuns(),
      cases = this.cases(),
      plans = this.plans();
    const selected = this.db
      .prepare("SELECT value FROM settings WHERE key='agent_active_snapshot'")
      .get()?.value;
    const current = snapshots.find((s) => s.id === selected) || snapshots[0] || null;
    const data = current ? this.repo.evidence(current.id) : null;
    const coverage = data
      ? data.scopes.flatMap((s) =>
          services.map((service) => {
            const e = data.coverage.find(
              (c) => scopeKey(c) === scopeKey(s) && c.service === service,
            );
            const stale = e && Date.parse(data.as_of) - Date.parse(e.observed_at) > 48 * 3600000;
            return {
              ...s,
              service,
              status: stale ? 'stale' : e?.status || 'missing',
              observed_at: e?.observed_at || null,
              capability:
                service === 'ec2'
                  ? 'Low CPU eligibility'
                  : service === 's3'
                    ? 'Multipart storage review'
                    : 'Management-copy overlap',
              evidence_id: e?.id || null,
            };
          }),
        )
      : [];
    return {
      mode: 'offline-deterministic',
      connected: false,
      snapshots,
      current_dataset_id: current?.id || null,
      as_of: data?.as_of || null,
      cases,
      runs,
      plans,
      coverage,
      questions: this.questions(),
      suggestions: prompts,
      storage_error: this.supervisor.storageError,
      verified_savings_micros: null,
      summary: {
        review_ready: cases.filter(
          (c) =>
            c.dataset_id === current?.id &&
            c.readiness === 'ready_for_review' &&
            c.review_status !== 'dismissed',
        ).length,
        needs_evidence: cases.filter(
          (c) => c.dataset_id === current?.id && c.readiness === 'needs_evidence',
        ).length,
        policy_blocked: cases.filter(
          (c) => c.dataset_id === current?.id && c.readiness === 'policy_blocked',
        ).length,
        coverage_complete: coverage.filter((c) => c.status === 'complete').length,
        coverage_total: coverage.length,
      },
    };
  }
}
