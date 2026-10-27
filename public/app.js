import { formatMicros, formatRatioMicros } from '/money.js';
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const money = formatMicros;
const shortMoney = (n) => formatMicros(n, 2);
const signed = (n) => `${n > 0 ? '+' : ''}${money(n)}`;
const count = (n) => (n === null ? '—' : n.toLocaleString());
const percent = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'No baseline');
const ratio = (r) => (r ? formatRatioMicros(r.numerator_micros, r.denominator) : 'N/A');
const labels = {
  account_id: 'Account',
  region: 'Region',
  model: 'Model',
  workflow: 'Workflow',
  team: 'Team',
};
const routeLabels = {
  overview: 'Overview',
  investigations: 'Investigations',
  quality: 'Data quality',
  evidence: 'Evidence explorer',
  actions: 'Action tracker',
  settings: 'Workspace & history',
};
const state = {
  workspace: null,
  report: null,
  scope: {},
  route: 'overview',
  selected: null,
  busy: false,
  mutationBusy: false,
  syncNeeded: false,
  request: 0,
  evidenceKind: 'usage',
  evidenceQuery: '',
  evidencePage: 0,
  evidenceRequest: 0,
  filtersOpen: false,
};
const table = (headers, rows) =>
  `<div class="table-scroll"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}" class="table-empty">No matching records.</td></tr>`}</tbody></table></div>`;
const card = (label, value, sub, accent = '') =>
  `<article class="metric ${accent}"><p>${label}</p><strong>${value}</strong><small>${sub}</small></article>`;
const evidenceButton = (refs, dataset = state.workspace?.active_dataset_id, label) =>
  `<button class="evidence-link" data-refs="${esc(JSON.stringify(refs))}" data-dataset="${esc(dataset)}" ${refs.length ? '' : 'disabled'}>▤ ${label || `${refs.length} source record${refs.length === 1 ? '' : 's'}`} →</button>`;
function notice(message, isError = false) {
  $('#status').textContent = isError ? '' : message;
  $('#error').hidden = !isError;
  if (isError)
    $('#error').innerHTML =
      `${esc(message)} <button id="retry-load" class="text-button">Reload workspace</button>`;
}
async function api(path, { method = 'GET', body, token = state.workspace?.csrf || '' } = {}) {
  const response = await fetch(path, {
    method,
    headers:
      method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return result;
}
function currentDataset() {
  return state.workspace?.datasets.find((d) => d.id === state.workspace.active_dataset_id);
}
function busy(value, message = '') {
  value = value || state.mutationBusy;
  state.busy = value;
  $('#main').setAttribute('aria-busy', String(value));
  document
    .querySelectorAll('[data-mutation],#sample,#file,[data-scope],#reset-filters')
    .forEach((x) => {
      if (value) {
        if (!Object.hasOwn(x.dataset, 'wasDisabled')) x.dataset.wasDisabled = String(x.disabled);
        x.disabled = true;
      } else if (Object.hasOwn(x.dataset, 'wasDisabled')) {
        x.disabled = x.dataset.wasDisabled === 'true';
        delete x.dataset.wasDisabled;
      }
    });
  if (message) notice(message);
}
async function load(reset = false) {
  const request = ++state.request;
  busy(true, 'Loading saved evidence…');
  try {
    const workspace = await api('/api/state');
    if (request !== state.request) return;
    const scope =
      reset || workspace.active_dataset_id !== state.workspace?.active_dataset_id
        ? {}
        : state.scope;
    const report = workspace.active_dataset_id
      ? await api('/api/overview', {
          method: 'POST',
          token: workspace.csrf,
          body: { dataset_id: workspace.active_dataset_id, scope },
        })
      : null;
    if (request !== state.request) return;
    state.workspace = workspace;
    state.report = report;
    state.scope = report ? report.scope : {};
    state.syncNeeded = false;
    notice('');
    render();
    return true;
  } catch (error) {
    if (request !== state.request) return;
    notice(error.message, true);
    if (!state.workspace)
      $('#content').innerHTML =
        '<section class="empty"><h2>Workspace unavailable</h2><p>Check the local server, then reload to try again.</p></section>';
    return false;
  } finally {
    if (request === state.request) busy(false);
  }
}
function invalidateDatasetView() {
  state.syncNeeded = true;
  state.report = null;
  state.scope = {};
  render();
}
async function synchronizeDatasetChange(message) {
  invalidateDatasetView();
  if (await load(true)) notice(message);
  else
    notice(
      `${message} The workspace refresh failed; previous analysis is hidden until you reload.`,
      true,
    );
}
async function applyScope() {
  const request = ++state.request,
    scope = { ...state.scope };
  busy(true, 'Recomputing the selected scope…');
  try {
    const report = await api('/api/overview', {
      method: 'POST',
      body: { dataset_id: state.workspace.active_dataset_id, scope },
    });
    if (request !== state.request) return;
    state.report = report;
    notice('');
    render();
  } catch (e) {
    if (request === state.request) {
      notice(e.message, true);
      state.scope = { ...state.report.scope };
      renderFilters();
    }
  } finally {
    if (request === state.request) busy(false);
  }
}
function renderFilters() {
  const r = state.report,
    visible = r && ['overview', 'investigations', 'quality'].includes(state.route);
  $('#filters').hidden = !visible;
  if (!visible) return;
  const option = (value, selected, label = value) =>
    `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  $('#filters').classList.toggle('filters-expanded', state.filtersOpen);
  $('#filters').innerHTML =
    `<button id="toggle-filters" class="filter-toggle" aria-expanded="${state.filtersOpen}"><span>Filter & compare</span><b>${esc(state.scope.baseline)} → ${esc(state.scope.current)}</b><span>${state.filtersOpen ? '−' : '＋'}</span></button><div class="period-controls"><label>Baseline<select data-scope="baseline">${r.trend.map((p) => option(p.period, state.scope.baseline)).join('')}</select></label><span class="compare-arrow">→</span><label>Comparison<select data-scope="current">${r.trend.map((p) => option(p.period, state.scope.current)).join('')}</select></label><span class="scope-label">FIXED ALLOCATION<br>FILTERED VIEW</span></div><div class="dimension-controls">${Object.entries(
      labels,
    )
      .map(
        ([key, label]) =>
          `<label>${label}<select data-scope="${key}">${option('', state.scope[key] || '', `All ${label.toLowerCase()}s`)}${r.facets[key].map((v) => option(v, state.scope[key])).join('')}</select></label>`,
      )
      .join('')}<button id="reset-filters" class="text-button">Reset</button></div>`;
}
function heading(title, subtitle, action = '') {
  return `<div class="page-title"><div><p class="eyebrow">AWS FINOPS WORKBENCH</p><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function render() {
  if (!state.workspace) return;
  const bits = location.hash.replace(/^#\/?/, '').split('/');
  state.route = Object.hasOwn(routeLabels, bits[0]) ? bits[0] : 'overview';
  state.selected = bits[1] || null;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === state.route;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#crumb').textContent = routeLabels[state.route];
  $('#inv-count').textContent = state.workspace.investigations.length || '';
  renderFilters();
  const titles = {
    overview: [
      'Know where your AI spend goes.',
      'From AWS usage to workflow outcomes. Investigate with evidence, not assumptions.',
    ],
    investigations: [
      'Ask a question. Follow the evidence.',
      'Guided investigations with explicit calculations, source records and unknowns.',
    ],
    quality: [
      'Trust starts with reconciliation.',
      'Make missing attribution, billing differences and coverage gaps visible.',
    ],
    evidence: [
      'The records behind every answer.',
      'Inspect immutable imported records. No generated values or hidden source substitutions.',
    ],
    actions: [
      'Turn findings into follow-through.',
      'Track decisions locally. Actions are review tasks, never automated cloud changes.',
    ],
    settings: [
      'Your local workspace.',
      'Manage saved datasets and inspect the record of local changes.',
    ],
  };
  $('#page-heading').innerHTML = heading(
    ...titles[state.route],
    state.route === 'overview'
      ? '<a class="button" href="#/investigations">Start investigation →</a>'
      : '',
  );
  $('#import-open').disabled = state.syncNeeded;
  if (state.syncNeeded) {
    $('#content').innerHTML =
      '<section class="empty"><h2>Refresh required</h2><p>A dataset change was saved or its response was interrupted. Previous analysis is hidden to avoid showing stale evidence.</p><button class="button" data-reload>Reload workspace</button></section>';
    return;
  }
  if (!state.report && !['actions', 'settings', 'investigations'].includes(state.route)) {
    $('#content').innerHTML =
      `<section class="empty"><div class="empty-icon">◫</div><h2>Your evidence starts here</h2><p>Load six months of synthetic AWS activity, or import a compatible dataset.<br>Your saved investigations remain available after clearing the active view.</p><button class="button" data-open-import>Load or import data</button></section>`;
    return;
  }
  const views = {
    overview: renderOverview,
    investigations: renderInvestigations,
    quality: renderQuality,
    evidence: renderEvidence,
    actions: renderActions,
    settings: renderSettings,
  };
  views[state.route]();
  busy(state.busy);
}
function trendChart(r) {
  const max = Math.max(...r.trend.map((p) => p.total_micros), 1),
    w = 680,
    h = 185,
    points = r.trend.map((p, i) => [
      48 + (i * (w - 76)) / Math.max(1, r.trend.length - 1),
      h - 22 - (p.total_micros / max) * (h - 45),
    ]);
  return `<svg class="trend-chart" viewBox="0 0 ${w} ${h + 28}" role="img" aria-label="Scoped spend trend across ${r.trend.length} periods">${[0, 0.5, 1].map((f) => `<line x1="48" x2="${w - 18}" y1="${h - 22 - f * (h - 45)}" y2="${h - 22 - f * (h - 45)}" stroke="#e6ebe9" stroke-dasharray="3 4"/><text x="0" y="${h - 17 - f * (h - 45)}" fill="#778580" font-size="10">${esc(shortMoney(Math.round(max * f)))}</text>`).join('')}<path d="M ${points[0][0]} ${h - 22} L ${points.map((p) => p.join(' ')).join(' L ')} L ${points.at(-1)[0]} ${h - 22} Z" fill="#e7f1ec"/><polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#167351" stroke-width="3" stroke-linejoin="round"/>${r.trend.map((p, i) => `<circle cx="${points[i][0]}" cy="${points[i][1]}" r="${p.period === r.scope.current ? 6 : 4}" fill="#167351" stroke="#fff" stroke-width="2"><title>${esc(p.period)}: ${money(p.total_micros)}</title></circle><text x="${points[i][0]}" y="${h + 9}" text-anchor="middle" fill="#778580" font-size="11">${esc(p.period)}</text>`).join('')}</svg>`;
}
function renderOverview() {
  const r = state.report,
    c = r.current,
    b = r.baseline,
    issues = r.quality.filter((x) => x.period === c.period || !x.period);
  $('#content').innerHTML =
    `<div class="context-strip"><span class="live-mark">●</span><b>${esc(currentDataset()?.name)}</b><span>Immutable version ${state.workspace.active_dataset_id.slice(0, 8)}</span><span class="pill neutral">OFFLINE · DETERMINISTIC</span></div><section class="metrics">${card('Scoped spend', shortMoney(c.total_micros), `${signed(r.delta_micros)} vs ${esc(b.period)}<span class="metric-tag">${percent(r.delta_micros, b.total_micros)}</span>`)}${card('Direct cost / success', ratio(c.direct_cost_per_success), `${count(c.covered_successes)} of ${count(c.successes)} successes have cost links`)}${card('Successful outcomes', count(c.successes), `${count(c.failures)} failed workflows · imported labels`)}${card('Unallocated spend', shortMoney(c.unallocated_micros), 'Kept outside workflow outcome costs', 'warning')}</section>
 <div class="overview-grid"><section class="panel trend-panel"><div class="panel-heading"><div><p class="eyebrow">SPEND OVER TIME</p><h2>Spend across selected records.</h2></div><span class="legend"><i></i> Scoped cost</span></div>${trendChart(r)}<details class="chart-data"><summary>View exact trend values</summary>${table(
   ['Period', 'Spend', 'Direct / success'],
   r.trend.map(
     (p) =>
       `<tr><td>${esc(p.period)}</td><td>${money(p.total_micros)}</td><td>${ratio(p.direct_cost_per_success)}</td></tr>`,
   ),
 )}</details><p class="caption">${esc(r.limitations[0])}</p></section><section class="panel attention"><p class="eyebrow">NEEDS ATTENTION</p><h2>Signals worth investigating</h2>${
   r.anomalies
     .slice(0, 3)
     .map(
       (a, i) =>
         `<button class="signal" data-question="${esc(a.id === 'retries' ? 'Investigate retries and failures' : 'Why did spend change?')}"><span class="signal-number">0${i + 1}</span><span><b>${esc(a.title)}</b><small>${signed(a.amount_micros)} · rule-based signal</small></span><span>→</span></button>`,
     )
     .join('') ||
   '<p class="muted">No threshold signals in this scope. This does not prove there are no anomalies.</p>'
 }<p class="caption">Spend flags: ≥30% and ≥$5 versus baseline. Retry flag: attempt >1. Rule-based signals, not predictions.</p><div class="attention-footer"><span class="pill amber">${issues.length} quality findings</span><a href="#/quality">Review data →</a></div></section></div>
 <section class="panel"><div class="panel-heading"><div><p class="eyebrow">COST DRIVERS</p><h2>Where the difference comes from</h2></div><select id="contribution-dim" aria-label="Group cost drivers"><option value="workflow">By workflow</option><option value="model">By model</option><option value="account_id">By account</option><option value="region">By region</option><option value="team">By team</option></select></div><div id="contribution-table"></div><p class="caption">Contributions sum to the exact scoped spend change. These comparisons identify differences, not causes. Display cards round to cents; tables preserve microdollars.</p></section>
 <div class="split-grid"><section class="panel"><p class="eyebrow">OUTCOME ECONOMICS</p><h2>Cost is not the same as value.</h2><div class="definition-row"><span>Direct / successful outcome</span><b>${ratio(c.direct_cost_per_success)}</b></div><div class="definition-row"><span>All allocated / successful outcome</span><b>${ratio(c.allocated_cost_per_success)}</b></div><p class="caption">Direct numerator includes retries linked to successful outcomes. Allocated numerator adds failed-workflow spend and shared overhead. Neither metric estimates ROI.</p><p class="inline-warning">${esc(c.ratio_note)}</p>${evidenceButton(c.refs)}</section><section class="panel"><p class="eyebrow">INVESTIGATION SHORTCUTS</p><h2>Start with a better question.</h2>${state.workspace.suggestions.map((q) => `<button class="question-shortcut" data-question="${esc(q)}"><span>${esc(q)}</span>→</button>`).join('')}</section></div>`;
  renderContributions('workflow');
}
function renderContributions(dim) {
  const r = state.report,
    max = Math.max(1, ...r.contributions[dim].map((c) => Math.abs(c.delta_micros)));
  $('#contribution-table').innerHTML = table(
    [labels[dim], r.baseline.period, r.current.period, 'Change', 'Contribution', 'Evidence'],
    r.contributions[dim].map(
      (c) =>
        `<tr><td><b>${esc(c.label)}</b></td><td>${money(c.baseline_micros)}</td><td>${money(c.current_micros)}</td><td class="${c.delta_micros > 0 ? 'increase' : 'decrease'}">${signed(c.delta_micros)}</td><td><svg class="contribution-bar" viewBox="0 0 130 12" aria-hidden="true"><rect width="130" height="12" rx="3" fill="#edf1ed"/><rect width="${(Math.abs(c.delta_micros) / max) * 130}" height="12" rx="3" fill="${c.delta_micros > 0 ? '#d39b4b' : '#4b9274'}"/></svg></td><td>${evidenceButton(c.refs)}</td></tr>`,
    ),
  );
}
function renderInvestigations() {
  const invs = state.workspace.investigations,
    selected = invs.find((i) => i.id === state.selected);
  $('#content').innerHTML =
    `<section class="ask-panel"><div><span class="agent-symbol">✳</span><div><h2>Evidence analyst</h2><p>Offline guided mode · four supported investigation types · no LLM calls</p></div></div><form id="ask-form"><label class="sr-only" for="question">Investigation question</label><input id="question" name="question" maxlength="500" placeholder="Why did spend increase in the selected period?" required ${state.report ? '' : 'disabled'}><button class="button" data-mutation ${state.report ? '' : 'disabled'}>Investigate →</button></form><div class="suggestion-chips">${state.workspace.suggestions.map((q) => `<button data-question="${esc(q)}" ${state.report ? '' : 'disabled'}>${esc(q)}</button>`).join('')}</div>${state.report ? '<p class="caption">Questions use the selected filters and periods above. Natural language is routed by explicit keywords, not semantic model understanding.</p>' : '<p>Load a dataset to start a new investigation. Saved investigations remain readable.</p>'}<div id="ask-result" role="status"></div></section>
 <div class="investigation-layout"><aside class="panel case-list"><div class="panel-heading"><h3>Saved investigations</h3><span class="pill neutral">${invs.length}</span></div>${invs.map((i) => `<a href="#/investigations/${i.id}" class="case-item ${selected?.id === i.id ? 'selected' : ''}"><span class="case-type">${esc(i.mode === 'deterministic' ? 'DETERMINISTIC' : 'BEDROCK SELECTION')}</span><b>${esc(i.title)}</b><small>${esc(i.scope.baseline)} → ${esc(i.scope.current)}</small><small>${new Date(i.created_at).toLocaleString()}</small></a>`).join('') || '<p class="muted">No saved investigations yet.</p>'}</aside><section class="case-detail">${selected ? investigationDetail(selected) : `<div class="panel empty"><div class="empty-icon">⌕</div><h2>Open a saved investigation</h2><p>Or ask one of the suggested questions. Every supported result is saved with its original dataset and scope.</p></div>`}</section></div>`;
}
function investigationDetail(i) {
  return `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">VERIFIED EVIDENCE · ${esc(i.mode)}</p><h2>${esc(i.title)}</h2></div><span class="pill green">Saved locally</span></div><p class="investigation-summary">${esc(i.summary)}</p><div class="scope-chips"><span>Dataset ${i.dataset_id.slice(0, 8)}</span>${Object.entries(
    i.scope,
  )
    .filter(([, v]) => v)
    .map(([k, v]) => `<span>${esc(k)}: ${esc(v)}</span>`)
    .join(
      '',
    )}</div><h3>Investigation steps</h3><ol class="tool-steps">${i.steps.map((s) => `<li><span class="step-check">✓</span><div><code>${esc(s.tool)}</code><p>${esc(s.detail)}</p></div></li>`).join('')}</ol></section><section class="panel"><p class="eyebrow">FINDINGS</p><h2>What the evidence supports</h2>${i.findings.map((f, n) => `<article class="finding"><span class="finding-number">${String(n + 1).padStart(2, '0')}</span><div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p>${Object.keys(f.metrics).length ? `<details><summary>Exact calculation inputs</summary><pre>${esc(JSON.stringify(f.metrics, null, 2))}</pre></details>` : ''}${evidenceButton(f.refs, i.dataset_id)}</div></article>`).join('') || '<p>No matching findings for this scope.</p>'}</section><section class="panel"><p class="eyebrow">RECOMMENDED REVIEW</p><h2>Decide what happens next</h2>${i.recommendations
    .map((r, n) => {
      const tracked = state.workspace.actions.some(
        (a) => a.investigation_id === i.id && a.recommendation_index === n,
      );
      return `<article class="recommendation"><div><h3>${esc(r.title)}</h3><p>${esc(r.rationale)}</p></div><button class="button secondary small" data-track="${i.id}" data-index="${n}" data-mutation ${tracked ? 'disabled' : ''}>${tracked ? '✓ Tracked' : 'Track action'}</button></article>`;
    })
    .join(
      '',
    )}<p class="caption">Tracking records a local task. It does not modify AWS resources or imply savings.</p></section><section class="panel unknowns"><h3>Unknowns & boundaries</h3><ul>${i.unknowns.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`;
}
async function investigate(question) {
  if (state.busy || !state.report) return;
  if (state.route !== 'investigations') {
    location.hash = '/investigations';
    state.route = 'investigations';
    render();
  }
  const request = {
    dataset_id: state.workspace.active_dataset_id,
    scope: { ...state.scope },
    question,
    mode: 'offline',
  };
  const fingerprint = JSON.stringify(request);
  if (state.pendingInvestigation?.fingerprint !== fingerprint)
    state.pendingInvestigation = { fingerprint, request_id: crypto.randomUUID() };
  request.request_id = state.pendingInvestigation.request_id;
  const initialHash = location.hash;
  state.mutationBusy = true;
  busy(true, 'Running deterministic tools and verifying evidence…');
  if ($('#ask-result'))
    $('#ask-result').innerHTML =
      '<span class="spinner"></span> Validating scope → computing ledger → checking sources…';
  let saved;
  try {
    const result = await api('/api/investigate', { method: 'POST', body: request });
    if (!result.supported) {
      state.pendingInvestigation = null;
      if ($('#ask-result'))
        $('#ask-result').innerHTML =
          `<div class="notice warning"><b>Request not supported in offline mode.</b><p>${esc(result.message)}</p></div>`;
      notice('No investigation saved.');
      return;
    }
    saved = result;
    // Keep the confirmed result available even if the separate state refresh fails.
    if (!state.workspace.investigations.some((i) => i.id === saved.id))
      state.workspace.investigations.unshift(saved);
    state.pendingInvestigation = null;
    state.workspace = await api('/api/state');
    if (location.hash === initialHash) {
      location.hash = `/investigations/${result.id}`;
      render();
    }
    notice('Investigation saved with its immutable evidence version.');
  } catch (e) {
    if (saved) {
      if (location.hash === initialHash) {
        location.hash = `/investigations/${saved.id}`;
        render();
      }
      notice(
        `Investigation saved (${saved.id}), but the workspace refresh failed: ${e.message}. Reload to synchronize.`,
        true,
      );
    } else {
      notice(
        `Investigation response unavailable: ${e.message}. A network error may have occurred after saving; retrying this same question reuses its request ID.`,
        true,
      );
      if ($('#ask-result'))
        $('#ask-result').textContent =
          'Result not confirmed. Retry this question safely or reload saved investigations.';
    }
  } finally {
    state.mutationBusy = false;
    busy(false);
  }
}

function renderQuality() {
  const r = state.report,
    bills = r.reconciliation.filter((b) => b.period === r.current.period),
    issues = r.quality.filter((q) => q.period === r.current.period || !q.period),
    gap = bills.reduce((n, b) => n + b.gap_micros, 0);
  $('#content').innerHTML =
    `<section class="metrics">${card('Billing difference', money(gap), 'Selected account / region · current period', 'warning')}${card('Open quality findings', String(issues.length), 'Full current period · all accounts')}${card('Cost-link coverage', `${count(r.current.covered_successes)} / ${count(r.current.successes)}`, 'Scoped successful outcomes')}${card('Allocation policy', 'Token-weighted', 'Fixed account / region pools')}</section><div class="notice info">Billing tables use account and region filters only. Quality findings cover the complete current period across all accounts. Model, workflow and team filters do not narrow these source-completeness checks.</div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">SOURCE COMPLETENESS</p><h2>Billing → invocation reconciliation</h2></div><span class="pill amber">Gaps stay explicit</span></div>${table(
      ['Billing line', 'Account / region', 'Billed', 'Matched usage', 'Difference', 'Evidence'],
      bills.map(
        (b) =>
          `<tr><td>${esc(b.id)}</td><td>${esc(b.account_id)}<br><small>${esc(b.region)}</small></td><td>${money(b.cost_micros)}</td><td>${money(b.usage_micros)}</td><td class="increase">${signed(b.gap_micros)}</td><td>${evidenceButton(b.refs)}</td></tr>`,
      ),
    )}<p class="caption">Difference = billed − matched invocation costs. Negative gaps are overmatched usage. No tax, credit or timing explanation is inferred.</p></section><section class="panel"><p class="eyebrow">QUALITY REGISTER</p><h2>Know what is missing</h2>${issues.map((q) => `<article class="quality-item"><span class="pill ${q.severity === 'warning' ? 'amber' : 'neutral'}">${esc(q.type)}</span><div><h3>${esc(q.title)}</h3><p>${esc(q.detail)}</p>${q.amount_micros !== undefined ? `<b>${signed(q.amount_micros)}</b> · ` : ''}${evidenceButton(q.refs)}</div></article>`).join('') || '<p>No configured quality rules flagged this period. Completeness is not guaranteed.</p>'}</section><section class="panel"><p class="eyebrow">ALLOCATION LEDGER</p><h2>Where shared costs were assigned</h2><p class="caption">Computed once within each period/account/region using tagged workflow/team tokens. Largest remainder conserves each microdollar. Displaying current-period allocations matching the dashboard filters.</p>${table(
      ['Source', 'Account / region', 'Workflow / team', 'Assigned cost', 'Evidence'],
      r.allocation
        .filter((a) => a.period === r.current.period)
        .map(
          (a) =>
            `<tr><td>${esc(a.source_id)}</td><td>${esc(a.account_id)}<br>${esc(a.region)}</td><td>${esc(a.workflow)}<br><small>${esc(a.team)}</small></td><td>${money(a.cost_micros)}</td><td>${evidenceButton([`usage:${a.source_id}`])}</td></tr>`,
        ),
    )}</section>`;
}
function renderEvidence() {
  $('#content').innerHTML =
    `<section class="panel"><div class="evidence-toolbar"><label>Record collection<select id="evidence-kind">${['usage', 'billing_lines', 'outcomes'].map((k) => `<option value="${k}" ${k === state.evidenceKind ? 'selected' : ''}>${{ usage: 'Invocation / usage records', billing_lines: 'Billing lines', outcomes: 'Workflow outcomes' }[k]}</option>`).join('')}</select></label><form id="evidence-search"><label for="evidence-query">Search IDs, tags or values</label><div class="search-row"><input id="evidence-query" maxlength="100" value="${esc(state.evidenceQuery)}" placeholder="e.g. support, us-east-1"><button class="button secondary">Search</button></div></form><a class="text-button" href="/api/export?dataset=${state.workspace.active_dataset_id}" download>Export source JSON →</a></div><p class="caption">Evidence search covers the full active dataset; dashboard filters do not apply. Click a row’s source link to inspect the exact imported JSON.</p><div id="evidence-table"><div class="loading"><span class="spinner"></span>Reading local records…</div></div></section>`;
  loadEvidence();
}
async function loadEvidence() {
  const request = ++state.evidenceRequest;
  try {
    const result = await api(
      `/api/evidence?dataset=${state.workspace.active_dataset_id}&kind=${state.evidenceKind}&q=${encodeURIComponent(state.evidenceQuery)}&page=${state.evidencePage}`,
    );
    if (request !== state.evidenceRequest || state.route !== 'evidence') return;
    $('#evidence-table').innerHTML =
      table(
        ['Source ID', 'Period', 'Account / region', 'Workflow / model', 'Cost / result', 'Source'],
        result.rows.map(
          ({ ref, record: r }) =>
            `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.period)}</td><td>${esc(r.account_id || '—')}<br><small>${esc(r.region || '—')}</small></td><td>${esc(r.workflow || r.model || r.service || '—')}<br><small>${esc(r.model || r.team || '')}</small></td><td>${r.cost_micros !== undefined ? money(r.cost_micros) : esc(r.status)}</td><td>${evidenceButton([ref], undefined, 'Inspect')}</td></tr>`,
        ),
      ) +
      `<div class="pagination"><span>${result.total} matching records · page ${result.page + 1} of ${Math.max(1, Math.ceil(result.total / 25))}</span><div><button class="button secondary small" data-page="${result.page - 1}" ${result.page === 0 ? 'disabled' : ''}>← Previous</button><button class="button secondary small" data-page="${result.page + 1}" ${(result.page + 1) * 25 >= result.total ? 'disabled' : ''}>Next →</button></div></div>`;
  } catch (e) {
    if (request === state.evidenceRequest && state.route === 'evidence' && $('#evidence-table'))
      $('#evidence-table').innerHTML = `<p class="notice error">${esc(e.message)}</p>`;
  }
}
function renderActions() {
  const actions = state.workspace.actions;
  $('#content').innerHTML =
    `<section class="metrics compact">${['proposed', 'in-progress', 'done', 'dismissed'].map((s) => card(s.replace('-', ' '), String(actions.filter((a) => a.status === s).length), 'Local review tasks')).join('')}</section><div class="notice info">No cloud execution. “Done” is a user-recorded status, not a verified saving or an applied AWS change.</div><div class="action-list">${actions.map((a) => `<article class="panel action-card"><div class="panel-heading"><div><p class="eyebrow">RECOMMENDATION · VERSION ${a.version}</p><h2>${esc(a.title)}</h2></div><span class="pill ${a.status === 'done' ? 'green' : 'neutral'}">${esc(a.status)}</span></div><p>${esc(a.rationale)}</p><a href="#/investigations/${a.investigation_id}" class="text-button">Open originating investigation →</a> ${evidenceButton(a.refs, a.dataset_id)}<form class="action-form" data-action-id="${a.id}" data-version="${a.version}"><label>Status<select name="status">${['proposed', 'in-progress', 'done', 'dismissed'].map((s) => `<option ${a.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>Owner<input name="owner" maxlength="80" placeholder="Who will review this?" value="${esc(a.owner)}"></label><label class="action-note">Review note<textarea name="note" maxlength="1000" rows="2" placeholder="Record evidence, a decision, or a next step.">${esc(a.note)}</textarea></label><button class="button small" data-mutation>Save update</button></form><small class="muted">Last updated ${new Date(a.updated_at).toLocaleString()} · every save is recorded in workspace history</small></article>`).join('') || '<section class="panel empty"><h2>No tracked actions yet</h2><p>Open a saved investigation and track a recommendation.</p><a class="button" href="#/investigations">Explore investigations</a></section>'}</div>`;
}
function renderSettings() {
  const w = state.workspace;
  $('#content').innerHTML =
    `<div class="split-grid"><section class="panel"><p class="eyebrow">EXECUTION MODE</p><h2>Offline by default. Explicit by design.</h2><span class="pill green">${esc(w.mode)}</span><p>The shipped server uses deterministic investigation tools. The optional Bedrock adapter has a bounded read-only tool contract and mocked tests; it has not been verified with a live model.</p><p class="caption">No credentials, provider enablement or permission controls are exposed here. Model output cannot edit costs, scope, evidence or action state.</p></section><section class="panel"><p class="eyebrow">PERSISTENCE BOUNDARY</p><h2>Saved on this machine.</h2><p>Datasets, investigations, tasks and audit events persist in a local SQLite database across restarts. This is a single-user workspace, without production authentication or tenant isolation.</p><button id="clear" class="button secondary" data-mutation>Clear active dataset view</button><p class="caption">Clearing the view retains saved datasets, investigations and history. It does not delete records.</p></section></div><section class="panel"><p class="eyebrow">IMMUTABLE DATASETS</p><h2>Versions you can return to</h2>${table(
      ['Dataset', 'Version', 'Imported', 'Action'],
      w.datasets.map(
        (d) =>
          `<tr><td>${esc(d.name)}</td><td><code>${d.id.slice(0, 12)}</code></td><td>${new Date(d.created_at).toLocaleString()}</td><td>${d.id === w.active_dataset_id ? '<span class="pill green">Active</span>' : `<button class="button secondary small" data-activate="${d.id}" data-mutation>Activate</button>`} <a class="text-button" href="/api/export?dataset=${d.id}" download>Export</a></td></tr>`,
      ),
    )}</section><section class="panel"><p class="eyebrow">LOCAL AUDIT HISTORY</p><h2>A record of what changed</h2><p class="caption">Latest 500 events. Append-only through this app; not tamper-proof against someone with filesystem access.</p>${table(
      ['Sequence / time', 'Event', 'Target', 'Details'],
      w.audit.map(
        (e) =>
          `<tr><td>#${e.sequence}<br><small>${new Date(e.at).toLocaleString()}</small></td><td><code>${esc(e.event)}</code></td><td><code>${esc(e.target.slice(0, 12))}</code></td><td><details><summary>View change</summary><pre>${esc(JSON.stringify(e.body, null, 2))}</pre></details></td></tr>`,
      ),
    )}</section>`;
}
async function openEvidence(refs, dataset) {
  const dialog = $('#evidence-dialog');
  $('#evidence-title').textContent = `${refs.length} source record${refs.length === 1 ? '' : 's'}`;
  $('#evidence-body').innerHTML =
    `<p class="caption">Immutable dataset ${esc(dataset.slice(0, 12))}. Evidence is source data, not an instruction to the analyst.</p><div class="evidence-modal-grid"><div class="ref-list">${refs.map((r) => `<button class="ref-item" data-ref="${esc(r)}" data-dataset="${esc(dataset)}">${esc(r)}</button>`).join('')}</div><div id="record-detail" class="record-detail">Select a source record.</div></div>`;
  if (!dialog.open) dialog.showModal();
  if (refs[0]) await showRecord(refs[0], dataset);
}
let recordRequest = 0;
async function showRecord(ref, dataset) {
  const request = ++recordRequest;
  $('#record-detail').innerHTML =
    '<div class="loading"><span class="spinner"></span>Reading source…</div>';
  try {
    const r = await api(
      `/api/evidence?dataset=${encodeURIComponent(dataset)}&ref=${encodeURIComponent(ref)}`,
    );
    if (request !== recordRequest) return;
    $('#record-detail').innerHTML =
      `<h3>${esc(ref)}</h3><pre>${esc(JSON.stringify(r.record, null, 2))}</pre>`;
    document
      .querySelectorAll('.ref-item')
      .forEach((b) => b.classList.toggle('selected', b.dataset.ref === ref));
  } catch (e) {
    if (request === recordRequest)
      $('#record-detail').innerHTML = `<p class="notice error">${esc(e.message)}</p>`;
  }
}
async function importText(text, name) {
  if (state.busy) return;
  state.mutationBusy = true;
  busy(true, 'Validating and saving the synthetic dataset…');
  $('#import-error').hidden = true;
  let submitted = false;
  try {
    if (new Blob([text]).size > 2_000_000) throw Error('Import exceeds 2 MB.');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Error('Invalid JSON. Download the sample for the required schema.');
    }
    submitted = true;
    await api('/api/import', { method: 'POST', body: { data, name } });
    $('#import-dialog').close();
    location.hash = '/overview';
    await synchronizeDatasetChange(
      'Dataset validated and saved. Previous investigations retain their original evidence.',
    );
  } catch (e) {
    if (submitted && !e.status) {
      invalidateDatasetView();
      $('#import-dialog').close();
      notice(
        `Import response not confirmed: ${e.message}. Reload the workspace before retrying; it may already have saved.`,
        true,
      );
      return;
    }
    $('#import-error').textContent =
      `Import failed: ${e.message} The existing workspace was retained.`;
    $('#import-error').hidden = false;
    notice('Import failed; previous dataset retained.');
  } finally {
    state.mutationBusy = false;
    busy(false);
    $('#file').value = '';
  }
}
document.addEventListener('click', async (e) => {
  const target = e.target.closest('button,a');
  if (!target || target.disabled) return;
  if (target.dataset.close) {
    $(`#${target.dataset.close}`).close();
    return;
  }
  if (target.id === 'import-open' || target.hasAttribute('data-open-import')) {
    $('#import-error').hidden = true;
    $('#import-dialog').showModal();
    return;
  }
  if (target.id === 'sample') {
    try {
      const r = await fetch('/api/sample');
      if (!r.ok) throw Error('Sample unavailable.');
      await importText(await r.text(), 'AWS operations · six-month synthetic workspace');
    } catch (err) {
      notice(err.message, true);
    }
    return;
  }
  if (target.dataset.question) {
    await investigate(target.dataset.question);
    return;
  }
  if (target.dataset.refs) {
    await openEvidence(JSON.parse(target.dataset.refs), target.dataset.dataset);
    return;
  }
  if (target.dataset.ref) {
    await showRecord(target.dataset.ref, target.dataset.dataset);
    return;
  }
  if (target.id === 'toggle-filters') {
    state.filtersOpen = !state.filtersOpen;
    renderFilters();
    return;
  }
  if (target.id === 'reset-filters') {
    if (state.mutationBusy) return;
    state.scope = { baseline: state.report.scope.baseline, current: state.report.scope.current };
    await applyScope();
    return;
  }
  if (target.dataset.page) {
    state.evidencePage = Number(target.dataset.page);
    await loadEvidence();
    return;
  }
  if (target.id === 'retry-load' || target.hasAttribute('data-reload')) {
    if (state.mutationBusy) return;
    await load();
    return;
  }
  if (state.busy) return;
  if (target.dataset.track || target.dataset.activate || target.id === 'clear')
    state.mutationBusy = true;
  try {
    if (target.dataset.track) {
      busy(true);
      await api('/api/actions', {
        method: 'POST',
        body: {
          investigation_id: target.dataset.track,
          recommendation_index: Number(target.dataset.index),
        },
      });
      state.workspace = await api('/api/state');
      render();
      notice('Recommendation added to the local action tracker.');
    }
    if (target.dataset.activate) {
      busy(true);
      await api('/api/activate', { method: 'POST', body: { dataset_id: target.dataset.activate } });
      await synchronizeDatasetChange('Dataset activated.');
    }
    if (target.id === 'clear') {
      busy(true);
      await api('/api/clear', { method: 'POST', body: {} });
      await synchronizeDatasetChange('Active view cleared. Saved work remains available.');
    }
  } catch (err) {
    if ((target.dataset.activate || target.id === 'clear') && !err.status) invalidateDatasetView();
    notice(err.message, true);
  } finally {
    state.mutationBusy = false;
    busy(false);
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.dataset.scope) {
    if (state.mutationBusy) {
      renderFilters();
      busy(true);
      return;
    }
    state.scope[e.target.dataset.scope] = e.target.value;
    await applyScope();
  }
  if (e.target.id === 'contribution-dim') renderContributions(e.target.value);
  if (e.target.id === 'evidence-kind') {
    state.evidenceKind = e.target.value;
    state.evidencePage = 0;
    await loadEvidence();
  }
  if (e.target.id === 'file') {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 2_000_000) {
        $('#import-error').textContent = 'Import exceeds 2 MB.';
        $('#import-error').hidden = false;
        return;
      }
      await importText(await file.text(), file.name.slice(0, 100));
    }
  }
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'ask-form') {
    await investigate(new FormData(e.target).get('question'));
    return;
  }
  if (e.target.id === 'evidence-search') {
    state.evidenceQuery = $('#evidence-query').value;
    state.evidencePage = 0;
    await loadEvidence();
    return;
  }
  if (e.target.matches('.action-form') && !state.busy) {
    const form = e.target,
      values = Object.fromEntries(new FormData(form));
    state.mutationBusy = true;
    busy(true);
    try {
      await api(`/api/actions/${form.dataset.actionId}`, {
        method: 'PATCH',
        body: { ...values, version: Number(form.dataset.version) },
      });
      state.workspace = await api('/api/state');
      render();
      notice('Action updated; audit event saved.');
    } catch (err) {
      notice(err.message, true);
    } finally {
      state.mutationBusy = false;
      busy(false);
    }
  }
});
window.addEventListener('hashchange', () => {
  if (state.workspace) {
    render();
    window.scrollTo(0, 0);
  }
});
await load();
