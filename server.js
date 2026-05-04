const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ARTICLES_DIR = path.join(PUBLIC_DIR, 'articles');
const PORT = process.env.PORT || 5173;

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleSave(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
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
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
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
  if (urlPath === '/' || urlPath === '/admin' || urlPath === '/admin/') urlPath = '/admin.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  if (!fss.existsSync(filePath) || !fss.statSync(filePath).isFile()) {
    return send(res, 404, { error: 'not found' });
  }
  const data = await fs.readFile(filePath);
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/save') return await handleSave(req, res);
    if (req.method === 'GET') return await serveStatic(req, res);
    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Admin running at http://localhost:${PORT}/`);
  console.log(`Open http://localhost:${PORT}/admin.html`);
});
