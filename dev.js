// Local dev server — no Vercel login needed.
// Serves public/ as static files and routes /api/* to the handler modules.
// Reads credentials from .env.local automatically.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ───────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) process.env[key] = val;
  }
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ── API routes ─────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
    const handlerPath = path.join(__dirname, 'api', `${name}.js`);

    if (!fs.existsSync(handlerPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `No handler for /api/${name}` }));
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) body += chunk;
    try { req.body = body ? JSON.parse(body) : {}; }
    catch { req.body = {}; }

    // Minimal res shim matching Vercel's interface
    const headers = { 'Content-Type': 'application/json' };
    let statusCode = 200;
    const mockRes = {
      setHeader(k, v) { headers[k] = v; },
      status(code) { statusCode = code; return mockRes; },
      json(data) {
        res.writeHead(statusCode, headers);
        res.end(JSON.stringify(data));
      },
      end() { res.writeHead(statusCode, headers); res.end(); },
    };

    try {
      // Cache-bust so edits to handlers take effect on next request
      const { default: handler } = await import(`${handlerPath}?t=${Date.now()}`);
      await handler(req, mockRes);
    } catch (err) {
      console.error(`[api/${name}]`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static files ───────────────────────────────
  let filePath = path.join(
    __dirname,
    'public',
    url.pathname === '/' ? 'index.html' : url.pathname
  );

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`\n  ✓ Dev server running at http://localhost:${PORT}\n`);
});
