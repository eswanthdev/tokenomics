import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMicros, formatRatioMicros } from '../src/money.js';
test('formats large safe integer microdollars exactly without float conversion', () => {
  assert.equal(formatMicros(8999998991000001), '$8,999,998,991.000001');
  assert.equal(formatMicros(-8999998991000001), '-$8,999,998,991.000001');
  assert.equal(formatMicros(Number.MAX_SAFE_INTEGER), '$9,007,199,254.740991');
  assert.equal(formatMicros(1), '$0.000001');
  assert.equal(formatMicros(1000000), '$1.00');
});
test('rounds ratios and display cents exactly, ties away from zero', () => {
  assert.equal(formatRatioMicros(15000, 3), '$0.01');
  assert.equal(formatRatioMicros(-15000, 3), '-$0.01');
  assert.equal(formatRatioMicros(14999, 3), '$0.00');
  assert.equal(formatMicros(1005000, 2), '$1.01');
  assert.throws(() => formatMicros(1.5), RangeError);
  assert.throws(() => formatRatioMicros(1, 0), RangeError);
});
