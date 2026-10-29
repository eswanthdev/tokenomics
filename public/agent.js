import { formatOpportunity } from '/opportunity-money.js';
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const label = (s) =>
  ({
    ready_for_review: 'Ready for review',
    needs_evidence: 'Needs evidence',
    policy_blocked: 'Policy blocked',
    awaiting_evidence: 'Awaiting evidence',
    in_review: 'In review',
  })[s] ||
  s?.replaceAll('_', ' ') ||
  'Unknown';
const short = (s) => esc(s?.slice(0, 12));
const stamp = (s) =>
  s
    ? new Date(s).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'No snapshot';
const badge = (s) => `<span class="badge ${esc(s)}">${esc(label(s))}</span>`;
const icon = (s) =>
  `<span class="service-icon ${esc(s)}">${esc({ s3: 'S3', ec2: 'EC2', cloudtrail: 'CT' }[s])}</span>`;
const btn = (text, href, cls = '') => `<a class="btn ${cls}" href="${href}">${text}</a>`;
const list = (items) => `<ul class="list">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
const empty = (title, body, action = '') =>
  `<div class="panel empty"><h2>${esc(title)}</h2><p>${esc(body)}</p>${action}</div>`;
const sourceButton = (id, dataset) =>
  `<button class="source-button" data-source="${esc(id)}" data-dataset="${esc(dataset)}"><span>${esc(id)}</span><span aria-hidden="true">→</span></button>`;
let state = null,
  busy = false,
  loadVersion = 0,
  poll = null,
  questionDraft = '',
  questionRequest = null,
  unsupported = '',
  evidenceVersion = 0,
  navigationVersion = 0;
const planDrafts = new Map();
let noticeTimer;
const filters = { q: '', service: '', account: '', region: '', readiness: '' };
const route = () => {
  const [name = 'brief', id = ''] = (location.hash.replace(/^#\//, '') || 'brief').split('/');
  return { name, id };
};
function notice(message) {
  $('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    $('#notice').textContent = '';
  }, 5000);
}
function error(e) {
  $('#error').hidden = false;
  $('#error').textContent = e.message || 'Workspace request failed. Retry Refresh.';
}
async function api(path, body, method = 'POST') {
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': state.csrf },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'Workspace request failed.');
  return d;
}
async function load({ renderView = true } = {}) {
  const token = ++loadVersion;
  try {
    const next = await api('/api/agent/state');
    if (token !== loadVersion) return false;
    state = next;
    $('#error').hidden = true;
    if (state.storage_error) error(Error(state.storage_error));
    if (renderView) render();
    clearTimeout(poll);
    if (state.runs.some((r) => ['pending', 'running'].includes(r.state)))
      poll = setTimeout(() => load(), 400);
    return true;
  } catch (e) {
    if (token === loadVersion) {
      error(e);
      if (!state)
        $('#view').innerHTML = empty(
          'Workspace unavailable',
          'The local API could not be reached. Retry without losing saved work.',
          '<button class="btn" data-retry>Retry loading</button>',
        );
      bind();
    }
    return false;
  }
}
async function mutate(fn) {
  if (busy) return;
  busy = true;
  $('#error').hidden = true;
  document.querySelectorAll('[data-write]').forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    document.querySelectorAll('[data-write]').forEach((b) => (b.disabled = false));
  }
}
function heading(title, sub, action = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>${action}</div>`;
}
function currentCases() {
  return state.cases.filter((c) => c.dataset_id === state.current_dataset_id);
}
function amount(c) {
  return c.finding.savings.status === 'gross_opportunity'
    ? formatOpportunity(c.finding.savings)
    : 'Unquantified';
}
function amountNote(c) {
  return c.finding.savings.status === 'gross_opportunity'
    ? c.service === 's3'
      ? 'one-month gross scenario'
      : 'gross for supplied event volume'
    : 'more evidence required';
}
function askPanel() {
  return `<section class="ask-panel"><div class="ask-top"><h2>Investigate with your FinOps agent</h2><span>Guided questions · deterministic tools</span></div><form id="ask-form"><label class="sr-only" for="question">Investigation question</label><div class="ask-row"><textarea id="question" maxlength="500" placeholder="Compare review candidates and tell me what evidence is missing…" required>${esc(questionDraft)}</textarea><button data-write class="btn" type="submit">Investigate &nbsp; →</button></div></form><div class="suggestions">${state.suggestions.map((q, i) => `<button data-prompt="${i}">${esc(['Prioritize all three services', 'What blocks S3 cleanup?', 'Compare EC2 & CloudTrail'][i] || q)}</button>`).join('')}</div>${unsupported ? `<div class="gap" role="status"><strong>Capability boundary</strong><p>${esc(unsupported)}</p></div>` : ''}</section>`;
}
function recommendation(c) {
  return `<div class="recommendation">${icon(c.service)}<div><h3><a class="text-link" href="#/case/${c.id}">${esc(c.title)}</a></h3>${badge(c.readiness)}<p>${esc(c.team)} · ${esc(c.finding.scope.region)} · ${esc(c.effort)}</p></div><div class="rec-right"><div class="amount">${esc(amount(c))}<small>${esc(amountNote(c))}</small></div>${btn('Open case →', `#/case/${c.id}`, 'secondary')}</div></div>`;
}
function brief() {
  const cases = currentCases().filter((c) => c.review_status !== 'dismissed'),
    s = state.summary,
    top = cases.find((c) => c.readiness === 'ready_for_review') || cases[0];
  if (!state.current_dataset_id)
    return (
      heading(
        'Your daily brief',
        'Start with a complete synthetic investigation, without connecting AWS.',
      ) +
      empty(
        'Explore the evidence first',
        'No resource snapshot is loaded. The example includes realistic exclusions and coverage gaps.',
        '<button class="btn" data-write data-demo>Explore synthetic workspace</button>',
      )
    );
  return (
    heading(
      'Your daily brief',
      'A focused view of what deserves attention. No changes executed.',
      `<span class="date-label">Snapshot · ${stamp(state.as_of)}</span>`,
    ) +
    `<div class="brief-grid"><section class="brief-hero"><p class="eyebrow">THE NEXT BEST REVIEW</p><h2>${s.review_ready ? `${s.review_ready} opportunities are ready for a closer look.` : 'Resolve the evidence gaps before acting.'}</h2><p>${top ? esc(top.title) + '. ' + esc(top.readiness === 'ready_for_review' ? 'A quantified scenario is available. Validate eligibility with the owner before any change.' : top.finding.detail) : 'No review candidates were found in the completed assessment.'}</p>${top ? btn('Review the evidence &nbsp; →', `#/case/${top.id}`) : btn('Start investigation', '#/investigations')}<div class="hero-bottom">Prioritized by evidence readiness and review effort, not estimated dollars.</div></section><section class="brief-side"><h2>Trust starts with coverage</h2><div class="coverage-line"><span>Complete service / Region scopes</span><strong>${s.coverage_complete}<span class="coverage-total"> / ${s.coverage_total}</span></strong></div><div class="progress" aria-label="${s.coverage_complete} of ${s.coverage_total} scopes complete">${state.coverage.map((c) => `<span class="${c.status === 'complete' ? 'complete' : ''}"></span>`).join('')}</div><p class="coverage-note">${s.coverage_total - s.coverage_complete} scope checks need attention. Missing evidence is never treated as zero opportunity.</p><a class="text-link" href="#/coverage">Inspect coverage gaps →</a></section></div><div class="kpis">${[
      ['Ready for review', s.review_ready, 'Human eligibility review required'],
      ['Needs evidence', s.needs_evidence, 'Resolve uncertainty before change'],
      ['Policy blocked', s.policy_blocked, 'Exclusions or cleanup already in place'],
      ['Verified savings', '—', 'No post-change evidence supplied'],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="kpi"><span class="kpi-label">${a}</span><strong class="kpi-value">${b}</strong><span class="kpi-note">${c}</span></div>`,
      )
      .join(
        '',
      )}</div><div class="section-head"><div><h2>Prioritized investigations</h2><p>Individual scenarios. No overlapping savings total.</p></div><a class="text-link" href="#/opportunities">View all ${cases.length} cases →</a></div><section class="panel">${cases.slice(0, 3).map(recommendation).join('') || '<div class="empty">No current cases. Start an investigation.</div>'}</section>` +
    askPanel()
  );
}
function opportunities() {
  const cases = currentCases(),
    options = (key) => [...new Set(cases.map((c) => c.finding.scope[key]))].sort();
  const rows = cases.filter(
    (c) =>
      (!filters.service || c.service === filters.service) &&
      (!filters.account || c.finding.scope.account_id === filters.account) &&
      (!filters.region || c.finding.scope.region === filters.region) &&
      (!filters.readiness || c.readiness === filters.readiness) &&
      `${c.title} ${c.team} ${c.finding.resource_id} ${c.finding.scope.account_id}`
        .toLowerCase()
        .includes(filters.q.toLowerCase()),
  );
  const select = (key, first, values) =>
    `<label class="sr-only" for="filter-${key}">${first}</label><select id="filter-${key}" data-filter="${key}"><option value="">${first}</option>${values.map((v) => `<option value="${esc(v)}" ${filters[key] === v ? 'selected' : ''}>${esc(v === 'cloudtrail' ? 'CloudTrail' : v === 's3' ? 'S3' : v === 'ec2' ? 'EC2' : v)}</option>`).join('')}</select>`;
  return (
    heading(
      'Opportunity inbox',
      'Review the evidence before deciding what to change.',
      btn('Ask a question', '#/investigations', 'secondary'),
    ) +
    `<div class="tabs" aria-label="Readiness filters">${[
      ['', 'All cases'],
      ['ready_for_review', 'Ready for review'],
      ['needs_evidence', 'Needs evidence'],
      ['policy_blocked', 'Policy blocked'],
    ]
      .map(
        ([v, l]) =>
          `<button data-readiness="${v}" class="${filters.readiness === v ? 'active' : ''}" aria-pressed="${filters.readiness === v}">${l} &nbsp; ${cases.filter((c) => !v || c.readiness === v).length}</button>`,
      )
      .join(
        '',
      )}</div><div class="filters"><label class="search"><span class="sr-only">Search cases</span><input id="search" value="${esc(filters.q)}" placeholder="Search resource, team or account…"/></label>${select('service', 'All services', ['s3', 'ec2', 'cloudtrail'])}${select('account', 'All accounts', options('account_id'))}${select('region', 'All Regions', options('region'))}<button class="text-link" data-reset>Reset</button></div><div class="panel"><div class="inbox-head"><span>Investigation / readiness</span><span>Account / Region</span><span>Gross scenario</span><span class="inbox-owner">Review owner</span></div>${rows.map((c) => `<button class="inbox-row" data-case="${c.id}"><span class="inbox-title">${icon(c.service)}<span><strong>${esc(c.title)}</strong><small>${esc(c.team)} · ${esc(c.effort)} &nbsp; ${badge(c.readiness)} ${c.review_status !== 'not_started' ? badge(c.review_status) : ''}</small></span></span><span class="scope-cell">${esc(c.finding.scope.account_id)}<small>${esc(c.finding.scope.region)}</small></span><span class="amount">${esc(amount(c))}<small>${esc(amountNote(c))}</small></span><span class="scope-cell inbox-owner">${esc(state.plans.find((p) => p.case_id === c.id)?.owner || 'Unassigned')}</span></button>`).join('') || '<div class="empty"><h2>No matching cases</h2><p>Adjust the filters or reset to see all available evidence.</p><button class="btn secondary" data-reset>Reset filters</button></div>'}</div><p class="hint">${rows.length} of ${cases.length} cases · Latest snapshot only · Sorted by readiness, review effort and service. Figures are not bill savings.</p>`
  );
}
function timeline(run) {
  return `<ol class="timeline"><li>Evidence snapshot pinned<small>${short(run?.dataset_id)} · ${esc(run?.created_at || '')}</small></li>${(run?.steps || []).map((s) => `<li>${esc(s.worker.toUpperCase())} specialist · ${esc(s.state)}<small>${esc(s.scope.account_id)} / ${esc(s.scope.region)} · ${s.finding_count} assessments</small></li>`).join('')}<li>${esc(['running', 'pending'].includes(run?.state) ? 'Assessment in progress' : label(run?.state) || 'Assessment unavailable')}<small>${esc(run?.finished_at || 'Only recorded events are shown.')}</small></li></ol>`;
}
function caseView(id) {
  const c = state.cases.find((c) => c.id === id);
  if (!c)
    return empty(
      'Case unavailable',
      'The case may belong to a different local workspace.',
      btn('Back to inbox', '#/opportunities'),
    );
  const f = c.finding,
    run = state.runs.find((r) => r.id === c.run_id),
    plan = state.plans.find((p) => p.case_id === id),
    m = f.metrics;
  const facts = m
    ? Object.entries(m).map(([k, v]) => [
        k.replaceAll('_', ' '),
        k.endsWith('_bps') ? (Number(v) / 100).toFixed(2) + '%' : Number(v).toLocaleString('en-US'),
      ])
    : [];
  return (
    `<a class="back" href="#/opportunities">← Opportunity inbox</a>` +
    heading(
      c.title,
      `${c.service_label} · ${c.team} · ${f.scope.account_id} / ${f.scope.region}`,
      badge(c.readiness),
    ) +
    `<div class="case-layout case-detail"><div class="stack"><section class="panel panel-pad"><p class="eyebrow">THE OBSERVATION</p><h2>${esc(c.finding.status === 'review' ? 'A review candidate, not an instruction to change' : label(c.finding.status))}</h2><p class="body-copy">${esc(f.detail)}</p>${facts.length ? `<div class="fact-grid">${facts.map(([k, v]) => `<div class="fact"><strong>${esc(v)}</strong><span>${esc(k)}</span></div>`).join('')}</div>` : ''}<div class="inline-note">${esc(c.priority_reason)}</div></section><section class="panel panel-pad"><h2>What would make this safe to review?</h2>${list(c.prerequisites)}${f.blockers?.length ? `<div class="gap"><strong>Unresolved dependencies</strong>${list(f.blockers)}</div>` : ''}<p class="hint">These are required checks, not a claim that the proposed change is safe.</p></section><section class="panel panel-pad"><h2>Evidence behind the finding</h2><p class="body-copy">${f.refs.length} references · historical snapshot as of ${stamp(f.as_of)}. Coverage, source assertions and limitations stay attached to the case.</p>${f.refs.map((r) => sourceButton(r, c.dataset_id)).join('')}<details><summary>Rule, policy and exact calculation</summary><pre>${esc(JSON.stringify({ rule: f.rule_id, version: f.rule_version, coverage: f.coverage, policy: f.policy, metrics: f.metrics, savings: f.savings }, null, 2))}</pre></details></section><section class="panel panel-pad"><h2>Investigation timeline</h2><p class="hint">Recorded steps from the offline assessment. No live AI calls.</p>${timeline(run)}</section></div><aside class="stack"><section class="panel panel-pad scenario"><p class="eyebrow">CURRENT → REVIEW SCENARIO</p><p class="scenario-label">${esc(amountNote(c))}</p><div class="scenario-amount">${esc(amount(c))}</div><p>${esc(f.savings.assumption || f.savings.reason)}</p><div class="inline-note">Verified savings: unavailable. Gross opportunity is not realizable bill savings.</div>${plan ? btn('Open saved review plan →', `#/plan/${plan.id}`) : c.readiness === 'policy_blocked' ? '<p class="hint">No new review plan: an exclusion or existing policy applies.</p>' : `<button class="btn" data-write data-plan="${c.id}">Create a review plan →</button>`}</section><section class="panel panel-pad"><h2>Operational guardrails</h2><p class="body-copy"><strong>${esc(c.risk)}</strong></p><p class="body-copy">${esc(c.rollback)}</p><p class="hint">Review approval does not authorize execution. This workspace cannot change AWS resources.</p></section><section class="panel panel-pad meta-panel"><h2>Case context</h2><dl class="meta-list"><dt>Evidence window</dt><dd>${stamp(f.as_of)}</dd><dt>Rule</dt><dd>${esc(f.rule_id)} v${esc(f.rule_version)}</dd><dt>Source</dt><dd>User-reviewed PDF, page ${f.source.page}</dd><dt>Dataset</dt><dd>${short(c.dataset_id)}</dd><dt>Owner</dt><dd>${esc(plan?.owner || 'Unassigned')}</dd></dl></section></aside></div>`
  );
}
function investigations(id) {
  if (!id)
    return (
      heading(
        'Investigations',
        'Ask a bounded question. Reopen the evidence and decisions later.',
      ) +
      askPanel() +
      `<div class="section-head"><h2>Saved investigations</h2><span class="hint">${state.questions.length} saved</span></div><section class="panel">${
        state.questions
          .map((q) => {
            const run = state.runs.find((r) => r.id === q.run_id);
            return `<a class="investigation-card" href="#/investigation/${q.id}">${badge(run?.state || 'unavailable')}<h3>${esc(q.question)}</h3><p>${esc(q.services.map((s) => s.toUpperCase()).join(' + '))} · ${stamp(q.created_at)} · snapshot ${short(q.dataset_id)}</p></a>`;
          })
          .join('') ||
        '<div class="empty">No saved investigations yet. Ask a suggested question to begin.</div>'
      }</section>`
    );
  const q = state.questions.find((q) => q.id === id);
  if (!q)
    return empty(
      'Investigation unavailable',
      'Reopen a saved investigation from the list.',
      btn('Investigations', '#/investigations'),
    );
  const run = state.runs.find((r) => r.id === q.run_id),
    active = ['pending', 'running'].includes(run?.state),
    findings = (run?.findings || []).filter((f) =>
      q.services.includes(
        state.cases.find((c) => c.id === f.id)?.service ||
          { 'EC2-UTIL-001': 'ec2', 'S3-LIFECYCLE-001': 's3', 'CLOUDTRAIL-DUP-001': 'cloudtrail' }[
            f.rule_id
          ],
      ),
    ),
    cases = state.cases.filter(
      (c) => c.dataset_id === q.dataset_id && findings.some((f) => f.id === c.id),
    );
  return (
    `<a class="back" href="#/investigations">← Saved investigations</a>` +
    heading(
      q.question,
      'Guided investigation · immutable evidence · no provider calls',
      badge(run?.state || 'unavailable'),
    ) +
    `<div class="case-layout"><div class="stack"><section class="panel panel-pad"><div class="answer-heading"><span>t</span><h2>${active ? 'Checking the supplied evidence' : 'Evidence-led assessment'}</h2></div><p class="body-copy">${active ? 'The bounded supervisor is assessing the selected snapshot. You can cancel before publication.' : run?.state === 'cancelled' ? 'This assessment was cancelled. No partial findings were published.' : run?.error ? esc(run.error) : `The supervisor checked all three supported rule families across the supplied scopes. This answer selects ${esc(q.services.map((s) => s.toUpperCase()).join(', '))}: ${findings.length} assessments, including ${findings.filter((f) => f.status === 'no_finding').length} checks with no finding. No causal spend-change explanation or safe-to-execute decision is inferred.`}</p>${active ? `<button class="btn secondary" data-write data-cancel="${run.id}">Cancel assessment</button>` : ''}<div class="inline-note">${findings.filter((f) => f.status === 'insufficient_evidence').length} assessments lack sufficient evidence. Missing data is not zero. No verified savings are available.</div></section><section class="panel">${cases.map(recommendation).join('') || `<div class="empty">${active ? 'Results appear only after verification.' : 'No review cases in this result. Inspect the recorded status and coverage.'}</div>`}</section>${askPanel()}</div><aside class="panel panel-pad"><h2>Recorded tool activity</h2>${timeline(run)}<p class="hint">Deterministic specialists. Model inference is disabled.</p></aside></div>`
  );
}
function plans(id) {
  if (!id)
    return (
      heading('Review plans', 'A decision record, not an execution queue.') +
      (state.plans.length
        ? `<section class="panel">${state.plans.map((p) => `<a class="investigation-card" href="#/plan/${p.id}">${badge(p.status)}<h3>${esc(p.title)}</h3><p>${esc(p.owner || 'Unassigned owner')} · ${stamp(p.updated_at)} · version ${p.version}</p></a>`).join('')}</section>`
        : empty(
            'No review plans yet',
            'Open a reviewable case to preserve its baseline, prerequisites and verification packet.',
            btn('Explore opportunities', '#/opportunities'),
          ))
    );
  const savedPlan = state.plans.find((p) => p.id === id);
  const p = savedPlan ? { ...savedPlan, ...(planDrafts.get(id) || {}) } : null;
  if (!p)
    return empty('Plan unavailable', 'Choose a saved review plan.', btn('Review plans', '#/plans'));
  return (
    `<a class="back" href="#/plans">← Review plans</a>` +
    heading(
      p.title,
      'No action will be executed. A status update cannot verify savings.',
      badge(p.status),
    ) +
    `<div class="case-layout"><div class="stack"><section class="panel panel-pad"><h2>Review decision</h2><form id="plan-form" data-id="${p.id}" data-version="${p.version}"><label class="field">Owner label<input name="owner" maxlength="80" value="${esc(p.owner)}" placeholder="Who should review this?"/></label><label class="field">Review status<select name="status">${['draft', 'in_review', 'awaiting_evidence', 'dismissed'].map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${esc(label(s))}</option>`).join('')}</select></label><label class="field">Decision note<textarea name="note" maxlength="1000" placeholder="Record what was reviewed and what is still needed…">${esc(p.note)}</textarea></label><button class="btn" data-write>Save review decision</button>${planDrafts.has(p.id) ? '<button class="btn secondary" type="button" data-discard>Discard unsaved draft</button>' : ''}</form></section><section class="panel panel-pad"><h2>Decision history</h2>${[
      ...p.history,
    ]
      .reverse()
      .map(
        (h) =>
          `<div class="plan-history"><strong>${esc(h.event)} · ${esc(label(h.status))}</strong><p>${esc(h.owner || 'Unassigned')} · ${esc(h.at)}</p>${h.note ? `<p>${esc(h.note)}</p>` : ''}</div>`,
      )
      .join(
        '',
      )}</section></div><aside class="stack"><section class="panel panel-pad"><h2>Before any change</h2>${list(p.prerequisites)}<div class="inline-note">This plan authorizes no resource mutation.</div></section><section class="panel panel-pad"><h2>Verification packet</h2>${list(p.verification)}<p class="body-copy">Verified savings: <strong>unavailable</strong>. No later billing and operational evidence has been assessed.</p><details><summary>Preserved baseline</summary><pre>${esc(JSON.stringify(p.baseline, null, 2))}</pre></details><a class="text-link" href="#/case/${p.case_id}">Open original case →</a></section><section class="panel panel-pad"><h2>Recovery constraints</h2><p class="body-copy">${esc(p.rollback)}</p></section></aside></div>`
  );
}
function coverage() {
  return (
    heading(
      'Evidence coverage',
      'Fixture coverage is not an AWS connection. Each gap limits a specific capability.',
    ) +
    `<section class="panel panel-pad"><h2>${state.summary.coverage_complete} of ${state.summary.coverage_total} scope checks have complete evidence</h2><p class="body-copy">As of ${stamp(state.as_of)}. All supplied enabled account/Region pairs are assessed; discovery of the actual enabled Region list is not implemented.</p></section><div class="section-head"><h2>Account / Region capability map</h2><a class="text-link" href="#/setup">Connection readiness →</a></div><div class="coverage-grid">${state.coverage.map((c) => `<section class="panel coverage-card">${icon(c.service)}<h3>${esc(c.capability)}</h3><p>${esc(c.account_id)}<br/>${esc(c.region)}</p><span class="badge"><span class="status-dot ${c.status === 'complete' ? 'complete' : ''}"></span>${esc(c.status)}</span><p>${esc(c.status === 'complete' ? 'Supplied inventory is marked complete. Resource-specific exclusions and gaps may still apply.' : `This scope cannot establish ${c.capability.toLowerCase()} reliably. Supply complete, current permitted evidence; no broader scope is substituted.`)}</p>${c.evidence_id ? sourceButton(c.evidence_id, state.current_dataset_id) : ''}</section>`).join('') || '<div class="empty">No evidence snapshot selected.</div>'}</div>`
  );
}
function setup() {
  return (
    heading(
      'Connection readiness',
      'Your data and decisions stay local. AWS is not connected.',
      badge('unconnected'),
    ) +
    `<div class="pair"><section class="panel panel-pad"><p class="eyebrow">RUNNING NOW</p><h2>Synthetic, local investigation</h2>${list(['Versioned EC2, S3 and CloudTrail assessments', 'Local SQLite memory and decision history', 'Exact arithmetic and immutable evidence', 'No vendor telemetry, credentials or cloud changes'])}<a class="text-link" href="/rules">Open evidence import diagnostics →</a></section><section class="panel panel-pad"><p class="eyebrow">CONTROLLED DATA INPUT</p><h2>Import a synthetic snapshot</h2><p class="body-copy">Resource evidence contract v1, up to 2 MB. An import becomes the newest brief snapshot. Existing cases and plans remain saved.</p><label class="field">Resource JSON<input class="file-input" id="agent-import" type="file" accept=".json,application/json"/></label><button class="btn secondary" data-write data-demo>Load the guided example</button><p class="hint">Only synthetic data is accepted. No credentials are requested.</p></section></div><div class="section-head"><h2>Customer-hosted architecture · planned, not deployed</h2></div><section class="panel">${[
      [
        'Hosting boundary',
        'Choose a customer account and home Region; assess only enabled Regions. No account has been provisioned.',
      ],
      [
        'Identity & access',
        'Future Cognito sign-in and reviewed read-only permissions. The current app is local single-user.',
      ],
      [
        'Compute & memory',
        'Future ECS/Fargate and PostgreSQL with customer-owned evidence, logs and backups. SQLite is active locally.',
      ],
      [
        'Model inference',
        'Optional customer-approved Bedrock via a private endpoint; self-hosted inference is a future alternative. No model calls are enabled.',
      ],
      [
        'Verification & execution',
        'Later billed and operational evidence is required to verify outcomes. Resource-changing tools are excluded.',
      ],
    ]
      .map(
        ([title, desc], i) =>
          `<div class="setup-row"><span class="step-num">${i + 1}</span><div><h3>${title}</h3><p>${desc}</p></div><span class="badge">Not connected</span></div>`,
      )
      .join('')}</section>`
  );
}
function render() {
  if (!state) return;
  const r = route();
  const names = {
    brief: 'Daily brief',
    opportunities: 'Opportunity inbox',
    case: 'Investigation case',
    investigations: 'Investigations',
    investigation: 'Investigation',
    plans: 'Review plans',
    plan: 'Review plan',
    coverage: 'Evidence coverage',
    setup: 'Connection readiness',
  };
  $('#crumb').textContent = names[r.name] || 'Daily brief';
  for (const a of document.querySelectorAll('[data-nav]')) {
    const section =
      { case: 'opportunities', investigation: 'investigations', plan: 'plans' }[r.name] || r.name;
    a.classList.toggle('active', a.dataset.nav === section);
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const views = {
    brief,
    opportunities,
    case: () => caseView(r.id),
    investigations: () => investigations(),
    investigation: () => investigations(r.id),
    plans: () => plans(),
    plan: () => plans(r.id),
    coverage,
    setup,
  };
  $('#view').innerHTML = (views[r.name] || brief)();
  bind();
}
function evidenceSummary(r) {
  if (!r.facts)
    return `<div class="inline-note">${esc(r.service.toUpperCase())} inventory completeness: <strong>${esc(r.status)}</strong>. This is a source assertion within the supplied scope.</div>`;
  const f = r.facts;
  if (r.service === 's3')
    return `<h3>Two-snapshot comparison</h3><div class="pair">${f.snapshots.map((s) => `<section class="panel panel-pad"><p class="eyebrow">${esc(s.at.slice(0, 10))}</p><h3>${s.bytes === null ? 'Unknown bytes' : esc(Number(s.bytes).toLocaleString('en-US')) + ' bytes'}</h3><p class="hint">Pagination ${s.complete ? 'complete' : 'incomplete'} · part identity ${esc(s.parts_digest)}</p></section>`).join('')}</div><p class="hint">Unchanged parts do not prove an upload is abandoned. Producer confirmation is still required.</p>`;
  if (r.service === 'ec2')
    return `<h3>CPU observation window</h3><dl class="meta-list"><dt>Window</dt><dd>${esc(f.window_start)} → ${esc(f.window_end)}</dd><dt>Running samples</dt><dd>${esc(f.expected_samples ?? 'Unknown')} expected five-minute samples</dd><dt>Representative days</dt><dd>${esc(f.representative_days ?? 'Unknown')}</dd><dt>Known peaks</dt><dd>${f.peaks_represented === true ? 'Represented' : 'Unverified'}</dd></dl>`;
  return `<h3>Audit coverage identity</h3><dl class="meta-list"><dt>Canonical trail</dt><dd>${esc(f.canonical_arn)}</dd><dt>Management selectors</dt><dd>${esc(f.events.join(' + '))}</dd><dt>Required destination</dt><dd>${f.required_destination === null ? 'Unknown' : f.required_destination ? 'Yes — preserve' : 'Not marked required'}</dd></dl><p class="hint">Overlap is not authorization to remove an audit destination.</p>`;
}
function bind() {
  document.querySelector('[data-retry]')?.addEventListener('click', () => load());
  document
    .querySelectorAll('[data-case]')
    .forEach((b) => (b.onclick = () => (location.hash = '/case/' + b.dataset.case)));
  document.querySelectorAll('[data-prompt]').forEach(
    (b) =>
      (b.onclick = () => {
        questionDraft = state.suggestions[Number(b.dataset.prompt)];
        $('#question').value = questionDraft;
        $('#question').focus();
      }),
  );
  $('#question')?.addEventListener('input', (e) => {
    questionDraft = e.target.value;
    questionRequest = null;
  });
  $('#ask-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    mutate(async () => {
      if (!state.current_dataset_id)
        throw Error('Load a synthetic snapshot in Connection readiness first.');
      questionDraft = $('#question').value;
      const navigation = navigationVersion,
        submittedQuestion = questionDraft;
      const key = state.current_dataset_id + '|' + submittedQuestion;
      if (questionRequest?.key !== key) questionRequest = { key, id: crypto.randomUUID() };
      const result = await api('/api/agent/ask', {
        dataset_id: state.current_dataset_id,
        question: questionDraft,
        request_id: questionRequest.id,
      });
      if (!result.supported) {
        unsupported = result.message;
        if (navigation === navigationVersion) render();
        return;
      }
      if (!(await load({ renderView: false })))
        throw Error('Investigation accepted, but refresh failed. Retry the same question safely.');
      if (questionDraft === submittedQuestion) {
        questionRequest = null;
        questionDraft = '';
      }
      unsupported = '';
      if (navigation === navigationVersion) {
        location.hash = '/investigation/' + result.id;
        render();
      }
      notice('Investigation saved.');
    });
  });
  document.querySelectorAll('[data-readiness]').forEach(
    (b) =>
      (b.onclick = () => {
        filters.readiness = b.dataset.readiness;
        render();
      }),
  );
  document.querySelectorAll('[data-filter]').forEach(
    (b) =>
      (b.onchange = () => {
        filters[b.dataset.filter] = b.value;
        render();
      }),
  );
  $('#search')?.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    filters.q = e.target.value;
    render();
    $('#search').focus();
    $('#search').setSelectionRange(pos, pos);
  });
  document.querySelectorAll('[data-reset]').forEach(
    (b) =>
      (b.onclick = () => {
        Object.keys(filters).forEach((k) => (filters[k] = ''));
        render();
      }),
  );
  document.querySelectorAll('[data-plan]').forEach(
    (b) =>
      (b.onclick = () =>
        mutate(async () => {
          const navigation = navigationVersion;
          const p = await api('/api/agent/plans', { case_id: b.dataset.plan });
          if (!(await load({ renderView: false })))
            throw Error(
              'Plan saved, but refresh failed. Refresh to reopen; creating it again safely reuses the plan.',
            );
          if (navigation === navigationVersion) {
            location.hash = '/plan/' + p.id;
            render();
          }
          notice('Review plan created.');
        })),
  );
  $('#plan-form')?.addEventListener('input', (e) => {
    const f = e.currentTarget,
      v = new FormData(f);
    planDrafts.set(f.dataset.id, {
      version: Number(f.dataset.version),
      owner: v.get('owner'),
      status: v.get('status'),
      note: v.get('note'),
    });
  });
  $('[data-discard]')?.addEventListener('click', () => {
    planDrafts.delete(route().id);
    render();
  });
  $('#plan-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = new FormData(form);
    mutate(async () => {
      const submitted = {
        version: Number(form.dataset.version),
        status: values.get('status'),
        owner: values.get('owner'),
        note: values.get('note'),
      };
      const saved = await api(
        '/api/agent/plans/' + form.dataset.id,
        {
          version: Number(form.dataset.version),
          status: values.get('status'),
          owner: values.get('owner'),
          note: values.get('note'),
        },
        'PATCH',
      );
      const draft = planDrafts.get(form.dataset.id);
      if (
        !draft ||
        (draft.owner === submitted.owner &&
          draft.note === submitted.note &&
          draft.status === submitted.status)
      )
        planDrafts.delete(form.dataset.id);
      else if (draft.version === submitted.version)
        planDrafts.set(form.dataset.id, { ...draft, version: saved.version });
      if (!(await load()))
        throw Error('Review saved. Refresh failed; reload before another update.');
      notice('Review decision saved. No AWS changes were executed.');
    });
  });
  document.querySelectorAll('[data-cancel]').forEach(
    (b) =>
      (b.onclick = () =>
        mutate(async () => {
          await api('/api/finops/cancel', { run_id: b.dataset.cancel });
          await load();
        })),
  );
  document.querySelectorAll('[data-source]').forEach(
    (b) =>
      (b.onclick = async () => {
        const version = ++evidenceVersion,
          hash = location.hash;
        try {
          const data = await api('/api/finops/evidence?dataset_id=' + b.dataset.dataset);
          if (version !== evidenceVersion || hash !== location.hash) return;
          const r = [...data.coverage, ...data.resources].find((r) => r.id === b.dataset.source);
          if (!r) throw Error('Source reference not found in this snapshot.');
          $('#evidence-title').textContent = r.display_name || r.id;
          $('#evidence-content').innerHTML =
            `<dl class="meta-list"><dt>Account</dt><dd>${esc(r.account_id)}</dd><dt>Region</dt><dd>${esc(r.region)}</dd><dt>Observed</dt><dd>${esc(r.observed_at)}</dd><dt>Dataset</dt><dd>${esc(b.dataset.dataset)}</dd></dl><p class="body-copy">Original synthetic source. Completeness and business eligibility remain source assertions, not live AWS verification.</p>${evidenceSummary(r)}<details><summary>Original source record</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details>`;
          if (!$('#evidence-dialog').open) $('#evidence-dialog').showModal();
        } catch (e) {
          error(e);
        }
      }),
  );
  document.querySelectorAll('[data-demo]').forEach(
    (b) =>
      (b.onclick = () =>
        mutate(async () => {
          const navigation = navigationVersion;
          const data = await (await fetch('/api/agent/sample')).json();
          const saved = await api('/api/finops/import', { data });
          const result = await api('/api/agent/ask', {
            dataset_id: saved.dataset_id,
            question: state.suggestions[0],
            request_id: crypto.randomUUID(),
          });
          if (!(await load())) throw Error('Example loaded; refresh to inspect its investigation.');
          if (navigation === navigationVersion) location.hash = '/investigation/' + result.id;
        })),
  );
  $('#agent-import')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    mutate(async () => {
      try {
        const navigation = navigationVersion;
        if (!file) return;
        if (file.size > 2_000_000) throw Error('Import exceeds 2 MB.');
        const saved = await api('/api/finops/import', { data: JSON.parse(await file.text()) });
        const result = await api('/api/agent/ask', {
          dataset_id: saved.dataset_id,
          question: state.suggestions[0],
          request_id: crypto.randomUUID(),
        });
        if (!(await load())) throw Error('Import accepted; refresh to inspect results.');
        if (navigation === navigationVersion) location.hash = '/investigation/' + result.id;
      } finally {
        if (document.contains(e.target)) e.target.value = '';
      }
    });
  });
}
$('.skip').onclick = (event) => {
  event.preventDefault();
  $('#main').focus();
  $('#main').scrollIntoView();
};
$('#refresh').onclick = () => load();
$('#evidence-close').onclick = () => $('#evidence-dialog').close();
window.addEventListener('hashchange', () => {
  clearTimeout(noticeTimer);
  $('#notice').textContent = '';
  evidenceVersion++;
  navigationVersion++;
  if ($('#evidence-dialog').open) $('#evidence-dialog').close();
  render();
  $('#main').focus();
  window.scrollTo(0, 0);
});
load();
