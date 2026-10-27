import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {analyze, ValidationError} from './engine.js';
const root = new URL('../', import.meta.url);
const files = {'/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'], '/api/sample': ['fixtures/support.json', 'application/json']};
export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'POST' && path === '/api/analyze') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) { res.writeHead(413); res.end('Import exceeds 2 MB.'); return; } chunks.push(chunk); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ValidationError('Invalid JSON. Download the sample to see the required format.'); }
        const result = analyze(input);
        res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(result)); return;
      }
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path];
        res.writeHead(200, {'Content-Type': type}); res.end(await readFile(new URL(file, root))); return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (error) {
      res.writeHead(error instanceof ValidationError ? 400 : 500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: error instanceof ValidationError ? error.message : 'Unable to analyze this import.'}));
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log(`Tokenomics: http://127.0.0.1:${port}`));
}
