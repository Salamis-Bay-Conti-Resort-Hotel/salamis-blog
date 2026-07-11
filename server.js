const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ARTICLES_DIR = path.join(PUBLIC_DIR, 'articles');
const PORT = process.env.PORT || 5173;

// --- Startup configuration validation ---------------------------------------

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_API_KEY || !ADMIN_API_KEY.trim()) {
  console.error('FATAL: ADMIN_API_KEY environment variable must be set. Refusing to start.');
  process.exit(1);
}

// --- Constants ---------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SLUG_RE = /^[a-zA-Z0-9-_]+$/;

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 60; // per IP, shared across the protected admin endpoints

const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https://api2.salamisbayconti.com http://api2.salamisbayconti.com data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// --- Security headers ---------------------------------------------------------

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', DEFAULT_CSP);
}

// --- API key auth --------------------------------------------------------------

function isValidApiKey(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(ADMIN_API_KEY, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  const header = req.headers['x-api-key'];
  const provided = Array.isArray(header) ? header[0] : header;
  return isValidApiKey(provided);
}

// --- In-memory rate limiter -----------------------------------------------------

const rateLimitStore = new Map(); // ip -> { count, resetAt }

function getClientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

const rateLimitSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now >= entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1000);
rateLimitSweepTimer.unref();

// --- Helpers ------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function contentLengthExceeds(req, maxBytes) {
  const cl = req.headers['content-length'];
  if (cl == null) return false;
  const n = Number(cl);
  return Number.isFinite(n) && n > maxBytes;
}

async function readBody(req, maxBytes) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      const err = new Error('Payload too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleSave(req, res) {
  if (contentLengthExceeds(req, MAX_BODY_BYTES)) {
    return send(res, 413, { error: 'payload too large' });
  }

  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err && err.statusCode === 413) return send(res, 413, { error: 'payload too large' });
    console.error('Error reading request body:', err);
    return send(res, 400, { error: 'invalid request body' });
  }

  let body;
  try { body = JSON.parse(raw); }
  catch { return send(res, 400, { error: 'invalid JSON body' }); }

  const { id, tr, en } = body || {};
  if (!id || !tr || !en || !tr.slug || !en.slug || tr.html == null || en.html == null) {
    return send(res, 400, { error: 'missing fields: id, tr.slug, tr.html, en.slug, en.html' });
  }
  if (!SLUG_RE.test(id) || !SLUG_RE.test(tr.slug) || !SLUG_RE.test(en.slug)) {
    return send(res, 400, { error: 'slugs must match [a-zA-Z0-9-_]+' });
  }

  await fs.mkdir(path.join(ARTICLES_DIR, 'tr'), { recursive: true });
  await fs.mkdir(path.join(ARTICLES_DIR, 'en'), { recursive: true });

  const trPath = path.join(ARTICLES_DIR, 'tr', tr.slug + '.html');
  const enPath = path.join(ARTICLES_DIR, 'en', en.slug + '.html');
  await fs.writeFile(trPath, tr.html, 'utf8');
  await fs.writeFile(enPath, en.html, 'utf8');

  const manifestPath = path.join(ARTICLES_DIR, 'manifest.json');
  let manifest = [];
  try {
    const raw2 = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw2);
    if (Array.isArray(parsed)) manifest = parsed;
  } catch {}

  const entry = {
    id,
    tr: { slug: tr.slug, title: tr.title || '' },
    en: { slug: en.slug, title: en.title || '' },
  };
  const idx = manifest.findIndex(e => e && e.id === id);
  if (idx >= 0) manifest[idx] = entry;
  else manifest.push(entry);

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  send(res, 200, {
    ok: true,
    files: {
      tr: `/articles/tr/${tr.slug}.html`,
      en: `/articles/en/${en.slug}.html`,
      manifest: '/articles/manifest.json',
    },
  });
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '/admin' || urlPath === '/admin/') {
    const html = await fs.readFile(path.join(ROOT, 'admin.html'), 'utf8');
    // Inline <script> in admin.html is allowed via a per-request nonce instead
    // of 'unsafe-inline', so injected script tags without the nonce are blocked.
    const nonce = crypto.randomBytes(16).toString('base64');
    const nonced = html.replace('<script>', `<script nonce="${nonce}">`);
    const adminCsp = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; ');
    res.setHeader('Content-Security-Policy', adminCsp);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(nonced);
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  if (!fss.existsSync(filePath) || !fss.statSync(filePath).isFile()) {
    return send(res, 404, { error: 'not found' });
  }
  const data = await fs.readFile(filePath);
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  res.end(data);
}

function runGit(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function handlePublish(req, res) {
  if (contentLengthExceeds(req, MAX_BODY_BYTES)) {
    return send(res, 413, { error: 'payload too large' });
  }

  let raw = '';
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err && err.statusCode === 413) return send(res, 413, { error: 'payload too large' });
    raw = '';
  }

  let body = {};
  try { body = JSON.parse(raw); } catch {}

  const title = (body.title || '').trim();
  const slug = (body.slug || '').trim();
  const customMsg = (body.message || '').trim();
  const message = customMsg
    || (title ? `add: ${title}` : (slug ? `publish: ${slug}` : 'publish article changes'));

  const status = await runGit(['status', '--porcelain', '--', 'public/articles']);
  if (status.code !== 0) {
    console.error('git status failed:', status.stderr);
    return send(res, 500, { error: 'unable to check repository status' });
  }
  if (!status.stdout.trim()) {
    return send(res, 200, { ok: true, skipped: true, message: 'No article changes to publish.' });
  }

  const add = await runGit(['add', '--', 'public/articles']);
  if (add.code !== 0) {
    console.error('git add failed:', add.stderr);
    return send(res, 500, { error: 'unable to stage changes' });
  }

  const staged = await runGit(['diff', '--cached', '--name-only', '--', 'public/articles']);
  if (!staged.stdout.trim()) {
    return send(res, 200, { ok: true, skipped: true, message: 'Nothing staged after add.' });
  }

  const commit = await runGit(['commit', '-m', message]);
  if (commit.code !== 0) {
    console.error('git commit failed:', commit.stderr || commit.stdout);
    return send(res, 500, { error: 'unable to commit changes' });
  }

  const push = await runGit(['push']);
  if (push.code !== 0) {
    console.error('git push failed:', push.stderr || push.stdout);
    return send(res, 500, {
      error: 'commit succeeded but push failed; check server logs',
      message,
    });
  }

  send(res, 200, {
    ok: true,
    message,
    files: staged.stdout.trim().split('\n'),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);

    const isAdminApi = req.method === 'POST' && (req.url === '/api/save' || req.url === '/api/publish');
    if (isAdminApi) {
      const ip = getClientIp(req);
      if (!checkRateLimit(ip)) {
        return send(res, 429, { error: 'too many requests' });
      }
      if (!isAuthorized(req)) {
        return send(res, 401, { error: 'unauthorized' });
      }
    }

    if (req.method === 'POST' && req.url === '/api/save') return await handleSave(req, res);
    if (req.method === 'POST' && req.url === '/api/publish') return await handlePublish(req, res);
    if (req.method === 'GET') return await serveStatic(req, res);
    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) send(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Admin running at http://localhost:${PORT}/`);
  console.log(`Open http://localhost:${PORT}/admin.html`);
});
