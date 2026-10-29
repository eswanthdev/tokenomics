import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOpportunity } from '../src/opportunity-money.js';
test('opportunity display rounds exact rational basis once and keeps small positive estimates visible', () => {
  const f = (n, d) =>
    formatOpportunity({
      status: 'gross_opportunity',
      numerator: String(n),
      denominator: String(d),
      gross_micros: '5000',
    });
  assert.equal(f(5368709115000n, 1073741824n), '<$0.01');
  assert.equal(f(5000n, 1n), '$0.01');
  assert.equal(f(0n, 1n), '$0.00');
  assert.equal(f(47104000n, 1n), '$47.10');
  assert.equal(f(900719925474099100n, 1n), '$900,719,925,474.10');
  assert.equal(formatOpportunity({ status: 'unquantified' }), 'Unquantified');
});
