// Format the exact rational microdollar basis once, never the already rounded micros.
export function formatOpportunity(savings) {
  if (savings.status !== 'gross_opportunity') return 'Unquantified';
  const n = BigInt(savings.numerator),
    d = BigInt(savings.denominator) * 10000n;
  if (n < 0n || d <= 0n) throw new RangeError('Invalid nonnegative opportunity fraction.');
  const cents = (n + d / 2n) / d;
  if (cents === 0n && n > 0n) return '<$0.01';
  return (
    '$' + (cents / 100n).toLocaleString('en-US') + '.' + (cents % 100n).toString().padStart(2, '0')
  );
}
