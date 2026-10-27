import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyze, allocate, ValidationError } from '../src/engine.js';
const fixture = JSON.parse(await readFile(new URL('../fixtures/support.json', import.meta.url)));
const sample = () => structuredClone(fixture);
test('AWS synthetic example has independently specified financial results', () => {
  const a = analyze(sample()),
    [b, c] = a.periods;
  assert.deepEqual([b.total_micros, c.total_micros], [100000000, 168000000]);
  assert.deepEqual([b.reconciliation_gap_micros, c.reconciliation_gap_micros], [5000000, 3000000]);
  assert.deepEqual([b.unallocated_micros, c.unallocated_micros], [0, 3000000]);
  assert.deepEqual(
    [b.workflows[0].total_micros, c.workflows[0].total_micros],
    [100000000, 165000000],
  );
  assert.deepEqual(
    [b.workflows[0].successful_direct_micros, c.workflows[0].successful_direct_micros],
    [45000000, 110000000],
  );
  assert.deepEqual([b.workflows[0].successes, c.workflows[0].successes], [3, 4]);
  assert.deepEqual(c.workflows[0].direct_cost_per_success, {
    numerator_micros: 110000000,
    denominator: 4,
  });
  assert.equal(a.investigation.delta_micros, 68000000);
  assert.equal(a.investigation.percent_change, 68);
  assert.deepEqual(
    a.investigation.contributions.map((x) => x.delta_micros),
    [60000000, 18000000, -10000000],
  );
  assert.equal(
    a.investigation.contributions.reduce((n, c) => n + c.delta_micros, 0),
    68000000,
  );
  for (const p of a.periods) {
    assert.equal(
      p.total_micros,
      p.unallocated_micros + p.workflows.reduce((n, w) => n + w.total_micros, 0),
    );
    assert.equal(
      p.billing_reconciliation.reduce((n, r) => n + r.gap_micros, 0),
      p.reconciliation_gap_micros,
    );
  }
});
test('largest remainder tie-break and large integer products are exact', () => {
  assert.deepEqual(allocate(5, { b: 1, a: 1, c: 1 }), { a: 2, b: 2, c: 1 });
  assert.deepEqual(allocate(1_000_000_000, { a: 5_000_000_000_000, b: 5_000_000_000_000 }), {
    a: 500_000_000,
    b: 500_000_000,
  });
  assert.deepEqual(allocate(42, { a: 0 }), {});
  for (let micros = 0; micros < 100; micros++)
    assert.equal(
      Object.values(allocate(micros, { a: 11, b: 7, c: 3 })).reduce((a, b) => a + b, 0),
      micros,
    );
});
test('no eligible weight keeps shared costs unallocated', () => {
  const d = sample();
  for (const r of d.usage) {
    r.tokens = 0;
    r.input_tokens = 0;
    r.output_tokens = 0;
  }
  const a = analyze(d);
  assert.equal(a.periods[0].unallocated_micros, 30000000);
  assert.equal(a.periods[0].allocation.length, 0);
});
test('empty usage/outcomes and zero baseline have explicit null ratios', () => {
  const d = sample();
  d.usage = [];
  d.outcomes = [];
  const a = analyze(d);
  assert.equal(a.investigation.percent_change, null);
  assert.equal(a.periods[0].workflows.length, 0);
  assert.equal(a.periods[0].reconciliation_gap_micros, 105000000);
  const e = sample();
  for (const o of e.outcomes) o.status = 'failure';
  assert.equal(analyze(e).periods[0].workflows[0].direct_cost_per_success, null);
});
test('retries contribute once, and missing outcome links reduce coverage', () => {
  const d = sample();
  const retry = d.usage.find((r) => r.attempt === 2);
  assert.equal(retry.cost_micros, 20000000);
  d.usage.filter((r) => r.outcome_id === '2026-10-ticket-3').forEach((r) => (r.outcome_id = null));
  const w = analyze(d).periods[1].workflows[0];
  assert.equal(w.linked_successes, 3);
  assert.equal(w.successful_direct_micros, 80000000);
  assert.equal(w.total_micros, 165000000);
});
for (const [name, mutate] of Object.entries({
  'duplicate usage': (d) => d.usage.push(d.usage[0]),
  'duplicate outcome': (d) => d.outcomes.push(d.outcomes[0]),
  'fractional money': (d) => (d.usage[0].cost_micros = 0.1),
  'negative money': (d) => (d.usage[0].cost_micros = -1),
  'wrong period': (d) => (d.usage[0].period = 'missing'),
  'broken outcome': (d) => (d.usage[0].outcome_id = 'missing'),
  'cross-period outcome': (d) => (d.usage[0].outcome_id = '2026-10-ticket-1'),
  'bad tokens': (d) => d.usage[0].input_tokens++,
  'bad billing reference': (d) => (d.usage[0].billing_line_id = 'missing'),
  'billing total mismatch': (d) => d.periods[0].invoice_micros++,
  'live data': (d) => (d.synthetic = false),
  currency: (d) => (d.currency = 'EUR'),
  'shared outcome link': (d) => (d.usage[0].shared = true),
  'tag mismatch': (d) => (d.usage[0].tags.workflow = 'other'),
  'too many rows': (d) => (d.usage = Array(5001).fill(d.usage[0])),
}))
  test(`rejects ${name}`, () => {
    const d = sample();
    mutate(d);
    assert.throws(() => analyze(d), ValidationError);
  });

test('many sub-cent invocations preserve cost before display rounding', () => {
  const d = sample();
  const row = d.usage[0];
  d.usage = Array.from({ length: 2000 }, (_, i) => ({ ...row, id: `tiny-${i}`, cost_micros: 10 }));
  d.periods[0].invoice_micros = 20000;
  d.billing_lines[0].cost_micros = 20000;
  d.periods[1].invoice_micros = 0;
  d.billing_lines[1].cost_micros = 0;
  const a = analyze(d);
  assert.equal(a.periods[0].total_micros, 20000); // 2,000 × $0.000010 = $0.02, not $0.
  assert.equal(a.periods[0].reconciliation_gap_micros, 0);
  assert.equal(a.periods[0].workflows[0].successful_direct_micros, 20000);
});
