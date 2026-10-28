const displayGross = (micros) => {
  const n = BigInt(micros);
  return (
    '$' + (n / 1000000n).toLocaleString('en-US') + '.' + (n % 1000000n).toString().padStart(6, '0')
  );
};
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let state,
  busy = false,
  poll,
  generation = 0,
  scopeGeneration = 0,
  resolvedScopeId = null,
  requestId = null;
async function api(path, body) {
  const response = await fetch(
    '/api/finops/' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': state.csrf },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}
function error(e) {
  $('#error').hidden = false;
  $('#error').textContent = e.message;
}
function controls() {
  for (const s of ['#sample', '#run', '#import', '#snapshot']) $(s).disabled = busy || !state;
  $('#run').disabled = busy || !$('#snapshot').value || resolvedScopeId !== $('#snapshot').value;
}
async function refresh() {
  const token = ++generation;
  try {
    const next = await api('state');
    if (token !== generation) return false;
    const selected = $('#snapshot').value,
      run = $('#runs').value;
    state = next;
    $('#snapshot').innerHTML =
      state.snapshots
        .map(
          (s) =>
            `<option value="${s.id}">${esc(s.as_of.slice(0, 10))} · ${s.id.slice(0, 16)}</option>`,
        )
        .join('') || '<option value="">No evidence imported</option>';
    if (state.snapshots.some((s) => s.id === selected)) $('#snapshot').value = selected;
    $('#runs').innerHTML =
      state.runs
        .map(
          (r) =>
            `<option value="${r.id}">${esc(r.state)} · ${esc(r.created_at)} · ${r.id.slice(0, 8)}</option>`,
        )
        .join('') || '<option value="">No assessments yet</option>';
    if (state.runs.some((r) => r.id === run)) $('#runs').value = run;
    $('#catalog').innerHTML = state.catalog
      .map(
        (r) =>
          `<article><span class="eyebrow">${esc(r.id)} · ${esc(r.version)}</span><h3>${esc(r.title)}</h3><p>${esc(r.condition)}</p><details><summary>Policy, evidence & exclusions</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details></article>`,
      )
      .join('');
    $('#status').textContent =
      'Local memory loaded. Assessments use synthetic historical evidence.';
    $('#error').hidden = true;
    if (state.storage_error) error(new Error(state.storage_error));
    render();
    await showScope();
    controls();
    clearTimeout(poll);
    if (state.runs.some((r) => ['pending', 'running'].includes(r.state)))
      poll = setTimeout(refresh, 300);
    return true;
  } catch (e) {
    if (token !== generation) return false;
    error(e);
    $('#status').textContent = 'Refresh failed. Displayed results may be stale; retry Refresh.';
    return false;
  }
}
async function showScope() {
  const id = $('#snapshot').value;
  const token = ++scopeGeneration;
  resolvedScopeId = null;
  $('#scope').textContent = id ? 'Loading the selected snapshot scope…' : 'No evidence imported.';
  controls();
  if (!id) {
    $('#scope').textContent = 'No evidence imported.';
    return;
  }
  try {
    const data = await api('evidence?dataset_id=' + id);
    if ($('#snapshot').value !== id || token !== scopeGeneration) return;
    resolvedScopeId = id;
    $('#scope').textContent =
      data.scopes.map((s) => s.account_id + ' / ' + s.region).join(' · ') +
      ` · ${data.resources.length} resource representations · as of ${data.as_of}`;
    controls();
  } catch (e) {
    if ($('#snapshot').value !== id || token !== scopeGeneration) return;
    $('#scope').textContent =
      'Scope unavailable for the selected snapshot. Refresh before running an assessment.';
    controls();
    error(e);
  }
}
function render() {
  const run = state.runs.find((r) => r.id === $('#runs').value);
  if (!run) {
    $('#results').innerHTML = '<p>No assessment yet. Load evidence and run the agent.</p>';
    return;
  }
  $('#results').innerHTML =
    `<div class="run-summary"><span class="badge ${esc(run.state)}">${esc(run.state)}</span> ${run.steps.length} verified tasks · snapshot ${esc(run.dataset_id.slice(0, 16))}<p>Gross opportunities are individual scenarios, never a summed savings total.</p>${['pending', 'running'].includes(run.state) ? '<button id="cancel">Cancel assessment</button>' : ''}${run.error ? `<p>${esc(run.error)}</p>` : ''}</div><details><summary>Supervisor dispatch trace</summary>${run.steps.map((s) => `<p class="task">${esc(s.worker)} → ${esc(s.rule_id)} · ${esc(s.scope.account_id)} / ${esc(s.scope.region)} · ${s.finding_count} verified assessments</p>`).join('')}</details>` +
    run.findings
      .map(
        (f) =>
          `<article class="finding"><span class="badge ${esc(f.status)}">${esc(f.status.replaceAll('_', ' '))}</span><small>${esc(f.rule_id)} v${esc(f.rule_version)} · source p${f.source.page}</small><h3>${esc(f.resource_id || 'Coverage assessment')}</h3><small>${esc(f.scope.account_id)} / ${esc(f.scope.region)} · as of ${esc(f.as_of)}</small><p>${esc(f.detail)}</p>${f.blockers?.length ? `<p>Decision blockers: ${esc(f.blockers.join('; '))}</p>` : ''}<div class="calculation">${f.savings.status === 'gross_opportunity' ? `Gross one-scenario opportunity: <b>${esc(displayGross(f.savings.gross_micros))}</b><br/>Exact microdollar fraction: ${esc(f.savings.numerator)} / ${esc(f.savings.denominator)}<br/>${esc(f.savings.assumption)}<br/>${esc(f.savings.warning)}` : `Savings unquantified: ${esc(f.savings.reason)}`}</div>${f.metrics ? `<details><summary>Calculation inputs</summary><pre>${esc(JSON.stringify(f.metrics, null, 2))}</pre></details>` : ''}<p class="refs">${f.refs.map((id) => `<button data-ref="${esc(id)}">${esc(id)}</button>`).join('')}</p></article>`,
      )
      .join('');
  $('#cancel')?.addEventListener('click', () =>
    mutate(async () => {
      await api('cancel', { run_id: run.id });
    }),
  );
  for (const button of document.querySelectorAll('[data-ref]'))
    button.onclick = async () => {
      try {
        const data = await api('evidence?dataset_id=' + run.dataset_id);
        if ($('#runs').value !== run.id) return;
        const record = [...data.coverage, ...data.resources].find(
          (r) => r.id === button.dataset.ref,
        );
        if (!record) throw Error('Evidence reference unavailable.');
        $('#source').textContent = JSON.stringify({ dataset_id: run.dataset_id, record }, null, 2);
        if (!$('#evidence').open) $('#evidence').showModal();
      } catch (e) {
        error(e);
      }
    };
}
async function mutate(fn) {
  if (busy) return;
  busy = true;
  controls();
  $('#error').hidden = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    controls();
  }
}
$('#sample').onclick = () =>
  mutate(async () => {
    const { dataset_id } = await api('import', { data: await api('sample') });
    if (!(await refresh()) || !state.snapshots.some((s) => s.id === dataset_id))
      throw Error(
        'Evidence import was accepted, but refreshing saved snapshots failed. Retry Refresh; do not assume the import was lost.',
      );
    $('#snapshot').value = dataset_id;
    requestId = null;
  });
$('#import').onchange = (event) =>
  mutate(async () => {
    const file = event.target.files[0];
    try {
      if (!file) return;
      if (file.size > 2_000_000) throw Error('Import exceeds 2 MB.');
      const { dataset_id } = await api('import', { data: JSON.parse(await file.text()) });
      if (!(await refresh()) || !state.snapshots.some((s) => s.id === dataset_id))
        throw Error(
          'Evidence import was accepted, but refreshing saved snapshots failed. Retry Refresh; do not assume the import was lost.',
        );
      $('#snapshot').value = dataset_id;
      requestId = null;
    } finally {
      event.target.value = '';
    }
  });
$('#run').onclick = () =>
  mutate(async () => {
    requestId ||= crypto.randomUUID();
    const run = await api('run', { dataset_id: $('#snapshot').value, request_id: requestId });
    if (!(await refresh()) || !state.runs.some((r) => r.id === run.id))
      throw Error(
        'Assessment accepted; refreshing its saved state failed. Retry this run safely with the same request ID, or Refresh.',
      );
    $('#runs').value = run.id;
    render();
    requestId = null;
  });
$('#snapshot').onchange = () => {
  requestId = null;
  showScope();
  controls();
};
$('#runs').onchange = render;
$('#refresh').onclick = refresh;
$('#close').onclick = () => $('#evidence').close();
controls();
refresh();
