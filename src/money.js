// Currency display never converts a large integer microdollar value to a float.
const integer = (n) => {
  if (!Number.isSafeInteger(n)) throw new RangeError('Expected safe integer microdollars.');
  return BigInt(n);
};
function display(units, digits, negative) {
  const scale = 10n ** BigInt(digits);
  const absolute = units < 0n ? -units : units;
  const whole = (absolute / scale).toLocaleString('en-US');
  let fraction = (absolute % scale).toString().padStart(digits, '0');
  if (digits === 6) fraction = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
}
export function formatMicros(micros, digits = 6) {
  return formatRatioMicros(micros, 1, digits);
}
export function formatRatioMicros(numerator, denominator, digits = 2) {
  if (![2, 6].includes(digits) || !Number.isSafeInteger(denominator) || denominator <= 0)
    throw new RangeError('Expected a positive integer denominator and 2 or 6 decimal digits.');
  const n = integer(numerator),
    sign = n < 0n ? -1n : 1n;
  const d = BigInt(denominator) * 10n ** BigInt(6 - digits);
  const rounded = (sign * n + d / 2n) / d;
  return display(rounded, digits, n < 0n);
}
