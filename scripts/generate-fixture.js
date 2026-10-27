// Reproducible illustrative values, deliberately not AWS pricing.
import { writeFile } from 'node:fs/promises';
const data = {
  schema_version: 2,
  synthetic: true,
  currency: 'USD',
  periods: [],
  billing_lines: [],
  usage: [],
  outcomes: [],
};
const accounts = ['000000000001', '000000000002'];
const workflows = [
  ['support', 'customer-experience'],
  ['knowledge-search', 'product'],
  ['document-review', 'operations'],
];
for (let month = 5; month <= 10; month++) {
  const period = `2026-${String(month).padStart(2, '0')}`;
  const p = {
    id: period,
    start: `${period}-01`,
    end: `2026-${String(month + 1).padStart(2, '0')}-01`,
    invoice_micros: 0,
  };
  data.periods.push(p);
  for (let ai = 0; ai < 2; ai++) {
    const account_id = accounts[ai],
      region = ai ? 'eu-west-1' : 'us-east-1',
      bid = `bill-${period}-${ai + 1}`;
    const add = (fields) => {
      const r = {
        id: `inv-${period}-${ai + 1}-${data.usage.length + 1}`,
        period,
        billing_line_id: bid,
        account_id,
        region,
        service: 'AmazonBedrock',
        shared: false,
        attempt: 1,
        ...fields,
      };
      r.tokens = r.input_tokens + r.output_tokens;
      data.usage.push(r);
      return r;
    };
    for (const [wi, [workflow, team]] of workflows.entries()) {
      const count = 8 + month + wi * 2 + ai;
      for (let j = 0; j < count; j++) {
        const oid = `out-${period}-${ai + 1}-${wi}-${j}`;
        const failed =
          j % 9 === 0 || (month === 10 && workflow === 'support' && ai === 0 && j % 5 === 0);
        data.outcomes.push({
          id: oid,
          period,
          workflow,
          team,
          account_id,
          region,
          status: failed ? 'failure' : 'success',
        });
        const premium =
          workflow === 'document-review' ||
          (month === 10 && workflow === 'support' && ai === 0 && j % 3 !== 0);
        const cost = 850003 + month * 37001 + wi * 110003 + j * 15307 + (premium ? 3100011 : 0);
        // Two costless-link successes expose incomplete coverage, not a fabricated zero-cost claim.
        if (month === 10 && ai === 1 && workflow === 'knowledge-search' && (j === 1 || j === 2))
          continue;
        add({
          workflow,
          outcome_id: oid,
          model: premium ? 'bedrock-premium-synthetic' : 'bedrock-standard-synthetic',
          input_tokens: 12000 + j * 113,
          output_tokens: 1700 + j * 71,
          cost_micros: cost,
          invocation_status: failed ? 'failure' : 'success',
          tags: { workflow, team },
        });
        if (month === 10 && workflow === 'support' && ai === 0 && j % 3 === 0) {
          const first = data.usage.at(-1);
          first.invocation_status = 'failure';
          add({
            workflow,
            outcome_id: oid,
            model: first.model,
            input_tokens: first.input_tokens,
            output_tokens: first.output_tokens,
            cost_micros: cost,
            invocation_status: failed ? 'failure' : 'success',
            attempt: 2,
            tags: { workflow, team },
          });
        }
      }
    }
    add({
      workflow: null,
      outcome_id: null,
      model: 'bedrock-platform-overhead',
      input_tokens: 0,
      output_tokens: 0,
      cost_micros: 17000000 + month * 700001,
      invocation_status: 'overhead',
      shared: true,
      tags: { workflow: null, team: 'platform' },
    });
    add({
      workflow: null,
      outcome_id: null,
      model: 'bedrock-standard-synthetic',
      input_tokens: 7001,
      output_tokens: 1031,
      cost_micros: month === 10 ? 4800017 : 800003,
      invocation_status: 'success',
      tags: { workflow: null, team: 'unknown' },
    });
    const usage = data.usage
      .filter((r) => r.billing_line_id === bid)
      .reduce((n, r) => n + r.cost_micros, 0);
    const gap = month === 10 ? (ai ? -1250003 : 7250011) : 100003;
    const bill = {
      id: bid,
      period,
      account_id,
      region,
      service: 'AmazonBedrock',
      cost_micros: usage + gap,
    };
    data.billing_lines.push(bill);
    p.invoice_micros += bill.cost_micros;
  }
}
await writeFile(
  new URL('../fixtures/workbench.json', import.meta.url),
  JSON.stringify(data, null, 2) + '\n',
);
console.log(
  `${data.usage.length} usage records, ${data.outcomes.length} outcomes, ${data.periods.length} periods`,
);
