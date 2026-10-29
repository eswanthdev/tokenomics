import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { analyze, ValidationError } from './engine.js';
import { overview, runInvestigation, evidenceIndex, suggestions } from './workbench.js';
import { Store, ConflictError } from './store.js';
import { FinopsRepository, FinopsSupervisor } from './finops-agent.js';
import { catalog, catalogVersion } from './finops-rules.js';
import { AgentExperience } from './agent-experience.js';
const root = new URL('../', import.meta.url);
const files = {
  '/': ['public/agent.html', 'text/html'],
  '/costs': ['public/index.html', 'text/html'],
  '/rules': ['public/finops.html', 'text/html'],
  '/opportunity-money.js': ['src/opportunity-money.js', 'text/javascript'],
  '/agent.js': ['public/agent.js', 'text/javascript'],
  '/agent.css': ['public/agent.css', 'text/css'],
  '/finops': ['public/agent.html', 'text/html'],
  '/finops.js': ['public/finops.js', 'text/javascript'],
  '/finops.css': ['public/finops.css', 'text/css'],
  '/api/agent/sample': ['fixtures/agent-resources.json', 'application/json'],
  '/api/finops/sample': ['fixtures/resources.json', 'application/json'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/money.js': ['src/money.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/api/sample': ['fixtures/workbench.json', 'application/json'],
  '/api/sample-v1': ['fixtures/support.json', 'application/json'],
};
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function shape(value, allowed, required = allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw new ValidationError('Request contains missing or unsupported fields.');
  return value;
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new HttpError(415, 'Use application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, 'Import exceeds 2 MB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ValidationError('Invalid JSON. Download the sample for the required schema.');
  }
}
// Configuration is operator-controlled, never inferred from forwarded request headers.
export function previewOriginFromEnv(env, port) {
  if (env.TOKENOMICS_PREVIEW_ORIGIN !== undefined)
    return validatePreviewOrigin(env.TOKENOMICS_PREVIEW_ORIGIN);
  if (env.CODESPACES !== 'true') return null;
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/.test(env.CODESPACE_NAME || '') ||
    env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN !== 'app.github.dev' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Invalid Codespaces preview configuration.');
  return validatePreviewOrigin(`https://${env.CODESPACE_NAME}-${port}.app.github.dev`);
}
function validatePreviewOrigin(origin) {
  if (
    typeof origin !== 'string' ||
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-([1-9][0-9]{0,4})\.app\.github\.dev$/.test(origin)
  )
    throw new Error('Preview origin must be one exact HTTPS Codespaces port origin.');
  const host = new URL(origin).hostname;
  const port = Number(host.split('.')[0].split('-').at(-1));
  if (host.split('.')[0].length > 63 || port > 65535)
    throw new Error('Invalid Codespaces preview hostname or port.');
  return origin;
}
export function createServer({
  store,
  seed = false,
  modelAdapter = null,
  previewOrigin = null,
} = {}) {
  if (previewOrigin !== null) validatePreviewOrigin(previewOrigin);
  const previewHost = previewOrigin === null ? null : new URL(previewOrigin).host;
  const ownsStore = !store;
  store ||= new Store();
  const finops = new FinopsRepository(store);
  const supervisor = new FinopsSupervisor(finops);
  const csrf = randomBytes(32).toString('hex');
  const inFlight = new Set();
  if (seed && !store.datasets().length && !store.audit().length) {
    const data = JSON.parse(readFileSync(new URL('fixtures/workbench.json', root), 'utf8')),
      id = store.import(data, 'AWS operations · six-month synthetic workspace');
    const scope = { baseline: '2026-09', current: '2026-10' };
    const first = store.saveInvestigation(id, runInvestigation(data, scope, suggestions[0]));
    store.saveInvestigation(id, runInvestigation(data, scope, suggestions[1]));
    store.addAction(first.id, 0);
  }
  const experience = new AgentExperience(store, finops, supervisor);
  const seedReady = seed
    ? experience.seed(
        JSON.parse(readFileSync(new URL('fixtures/agent-resources.json', root), 'utf8')),
      )
    : Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      const host = req.headers.host || '';
      const isPreview = previewHost !== null && host === previewHost;
      if (!isPreview && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
        throw new HttpError(403, 'Host is not an approved local or preview host.');
      const origin = isPreview ? previewOrigin : `http://${host}`,
        url = new URL(req.url, origin),
        path = url.pathname;
      if (
        url.origin !== origin ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (isPreview && req.method !== 'GET' && req.headers.origin !== origin)
      )
        throw new HttpError(403, 'Cross-origin access is not allowed.');
      if (!['GET', 'POST', 'PATCH'].includes(req.method))
        throw new HttpError(405, 'Method not supported.');
      if (req.method !== 'GET' && req.headers['x-workspace-token'] !== csrf)
        throw new HttpError(403, 'Workspace token missing or stale. Reload this local page.');
      if (req.method === 'GET' && Object.hasOwn(files, path)) {
        const [file, type] = files[path];
        res.writeHead(200, { 'Content-Type': type });
        res.end(await readFile(new URL(file, root)));
        return;
      }
      if (req.method === 'GET' && path === '/api/agent/state') {
        await seedReady;
        send(200, { csrf, ...experience.state() });
        return;
      }
      if (req.method === 'POST' && path === '/api/agent/ask') {
        await seedReady;
        const input = shape(await body(req), ['dataset_id', 'question', 'request_id']);
        send(202, experience.ask(input));
        return;
      }
      if (req.method === 'POST' && path === '/api/agent/plans') {
        await seedReady;
        const input = shape(await body(req), ['case_id']);
        if (typeof input.case_id !== 'string')
          throw new ValidationError('case_id must be a string.');
        send(201, experience.createPlan(input.case_id));
        return;
      }
      if (req.method === 'PATCH' && path.startsWith('/api/agent/plans/')) {
        const input = shape(await body(req), ['version', 'status', 'owner', 'note']);
        send(200, experience.updatePlan(path.split('/').at(-1), input));
        return;
      }
      if (req.method === 'GET' && path === '/api/finops/state') {
        send(200, {
          csrf,
          catalog,
          catalog_version: catalogVersion,
          storage_error: supervisor.storageError,
          snapshots: finops.listEvidence(),
          runs: finops.listRuns(),
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/finops/evidence') {
        const data = finops.evidence(url.searchParams.get('dataset_id') || '');
        if (!data) throw new HttpError(404, 'Evidence snapshot not found.');
        send(200, data);
        return;
      }
      if (req.method === 'POST' && path === '/api/finops/import') {
        const input = shape(await body(req), ['data']);
        const dataset_id = finops.importEvidence(input.data);
        experience.activateSnapshot(dataset_id);
        send(201, { dataset_id });
        return;
      }
      if (req.method === 'POST' && path === '/api/finops/run') {
        const input = shape(await body(req), ['dataset_id', 'request_id']);
        send(202, supervisor.start(input.dataset_id, input.request_id));
        return;
      }
      if (req.method === 'POST' && path === '/api/finops/cancel') {
        const input = shape(await body(req), ['run_id']);
        if (typeof input.run_id !== 'string') throw new ValidationError('run_id must be a string.');
        send(202, supervisor.cancel(input.run_id));
        return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        send(200, {
          ...store.state(),
          csrf,
          mode: modelAdapter ? 'bedrock-available' : 'offline-deterministic',
          suggestions,
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/export') {
        const data = store.dataset(url.searchParams.get('dataset') || store.activeId());
        if (!data) throw new HttpError(404, 'Dataset not found.');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="tokenomics-synthetic-export.json"',
        );
        send(200, data);
        return;
      }
      if (req.method === 'GET' && path === '/api/evidence') {
        const data = store.dataset(url.searchParams.get('dataset') || store.activeId());
        if (!data) throw new HttpError(404, 'Dataset not found.');
        const reference = url.searchParams.get('ref');
        if (reference) {
          const index = evidenceIndex(data);
          if (!Object.hasOwn(index, reference))
            throw new HttpError(404, 'Evidence reference not found in this dataset.');
          send(200, { ref: reference, record: index[reference] });
          return;
        }
        const kind = url.searchParams.get('kind') || 'usage',
          q = url.searchParams.get('q') || '',
          page = Number(url.searchParams.get('page') || 0);
        if (
          !['usage', 'outcomes', 'billing_lines'].includes(kind) ||
          q.length > 100 ||
          !Number.isInteger(page) ||
          page < 0 ||
          page > 200
        )
          throw new ValidationError('Invalid evidence search or page.');
        const rows = data[kind].filter((r) =>
          JSON.stringify(r).toLowerCase().includes(q.toLowerCase()),
        );
        send(200, {
          total: rows.length,
          page,
          rows: rows
            .slice(page * 25, page * 25 + 25)
            .map((r) => ({ ref: `${kind}:${r.id}`, record: r })),
        });
        return;
      }
      if (req.method === 'POST' && path === '/api/import') {
        const input = shape(await body(req), ['data', 'name']);
        overview(input.data);
        const id = store.import(input.data, input.name);
        send(201, { dataset_id: id });
        return;
      }
      if (req.method === 'POST' && path === '/api/activate') {
        const input = shape(await body(req), ['dataset_id']);
        if (typeof input.dataset_id !== 'string')
          throw new ValidationError('dataset_id must be a string.');
        store.activate(input.dataset_id);
        send(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && path === '/api/clear') {
        shape(await body(req), []);
        store.clearActive();
        send(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && path === '/api/analyze') {
        send(200, analyze(await body(req)));
        return;
      }
      if (req.method === 'POST' && ['/api/overview', '/api/investigate'].includes(path)) {
        const input = shape(
          await body(req),
          path === '/api/overview'
            ? ['dataset_id', 'scope']
            : ['dataset_id', 'scope', 'question', 'mode', 'request_id'],
        );
        if (typeof input.dataset_id !== 'string')
          throw new ValidationError('dataset_id must be a string.');
        const data = store.dataset(input.dataset_id);
        if (!data) throw new HttpError(404, 'Dataset not found.');
        if (path === '/api/overview') {
          send(200, overview(data, input.scope));
          return;
        }
        if (!['offline', 'bedrock'].includes(input.mode))
          throw new ValidationError('Choose offline or bedrock mode.');
        if (
          typeof input.request_id !== 'string' ||
          !/^[a-zA-Z0-9_-]{8,100}$/.test(input.request_id)
        )
          throw new ValidationError('request_id must be an 8–100 character request identifier.');
        // Bound and validate intent/scope before a possible provider call.
        const deterministic = runInvestigation(data, input.scope, input.question);
        if (!deterministic.supported) {
          send(200, deterministic);
          return;
        }
        if (input.mode === 'bedrock' && !modelAdapter)
          throw new HttpError(409, 'Bedrock is not configured. Use offline deterministic mode.');
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify({
              dataset_id: input.dataset_id,
              scope: Object.fromEntries(
                Object.entries(deterministic.scope).sort(([a], [b]) =>
                  a < b ? -1 : a > b ? 1 : 0,
                ),
              ),
              question: input.question,
              mode: input.mode,
            }),
          )
          .digest('hex');
        const prior = store.investigationRequest(input.request_id, fingerprint);
        if (prior) {
          send(200, prior);
          return;
        }
        if (inFlight.has(input.request_id))
          throw new ConflictError(
            'This investigation request is still running. Retry the same request ID after completion.',
          );
        inFlight.add(input.request_id);
        try {
          let result = deterministic;
          if (input.mode === 'bedrock') {
            try {
              result = await modelAdapter.investigate(data, input.scope, input.question);
            } catch {
              throw new HttpError(
                502,
                'Model investigation failed or returned unverified content. Nothing was saved. Use offline mode or retry after review.',
              );
            }
          }
          send(
            201,
            store.saveInvestigation(input.dataset_id, result, {
              request_id: input.request_id,
              fingerprint,
            }),
          );
        } finally {
          inFlight.delete(input.request_id);
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/actions') {
        const input = shape(await body(req), ['investigation_id', 'recommendation_index']);
        if (typeof input.investigation_id !== 'string')
          throw new ValidationError('investigation_id must be a string.');
        send(201, store.addAction(input.investigation_id, input.recommendation_index));
        return;
      }
      if (req.method === 'PATCH' && /^\/api\/actions\/[a-z0-9-]{36}$/.test(path)) {
        send(200, store.updateAction(path.split('/').at(-1), await body(req)));
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      send(
        error instanceof ValidationError
          ? 400
          : error instanceof ConflictError
            ? 409
            : error.status || 500,
        {
          error:
            error instanceof ValidationError ||
            error instanceof ConflictError ||
            error instanceof HttpError
              ? error.message
              : 'Local workspace operation failed. Your previous saved state was retained.',
        },
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.finopsShutdown = async () => {
    supervisor.active?.controller.abort();
    await supervisor.completion;
  };
  if (ownsStore)
    server.on('close', async () => {
      await server.finopsShutdown();
      store.close();
    });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const previewOrigin = previewOriginFromEnv(process.env, port);
  const dir = resolve(process.env.TOKENOMICS_DATA_DIR || '.local');
  await mkdir(dir, { recursive: true });
  const store = new Store(resolve(dir, 'tokenomics.sqlite'));
  const server = createServer({ store, seed: true, previewOrigin });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Tokenomics workbench: http://127.0.0.1:${port}\nLocal database: ${resolve(dir, 'tokenomics.sqlite')}\nOffline deterministic mode; no provider calls.`,
    ),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () =>
      server.close(async () => {
        await server.finopsShutdown();
        store.close();
        process.exit(0);
      }),
    );
}
