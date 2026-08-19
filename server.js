const http = require('http');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 5000;
const APK_DOWNLOAD_URL = 'https://drive.usercontent.google.com/download?id=1aWkp8uCJ18OmKfXViYvgImfG_blyXFGL&export=download&confirm=t';
const ROOT = __dirname;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getRequestPath(req) {
  return new URL(req.url || '/', 'http://localhost').pathname;
}

function stripAppBase(requestPath) {
  return requestPath.replace(/^\/Official(?=\/|$)/i, '') || '/';
}

function setCommonHeaders(res, requestPath) {
  const noCache = ['/', '/index.html', '/sw.js', '/manifest.json', '/supabase-api.js'];
  if (noCache.includes(requestPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (requestPath.startsWith('/assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendText(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

async function proxyApk(res) {
  try {
    const upstream = await fetch(APK_DOWNLOAD_URL, {
      redirect: 'follow',
      headers: { Accept: 'application/vnd.android.package-archive,application/octet-stream' },
    });

    if (!upstream.ok || !upstream.body) {
      sendText(res, 502, 'APK download is temporarily unavailable.');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="star-follower.apk"');
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    sendText(res, 502, 'APK download is temporarily unavailable.');
  }
}

async function serveRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const originalPath = getRequestPath(req);
  if (originalPath === '/download/star-follower.apk') {
    await proxyApk(res);
    return;
  }

  const requestPath = stripAppBase(originalPath);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const candidate = path.resolve(ROOT, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
  if (!candidate.startsWith(`${ROOT}${path.sep}`) && candidate !== ROOT) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let filePath = candidate;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(ROOT, 'index.html');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }

  setCommonHeaders(res, requestPath);
  res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.end();
    return;
  }
  fs.createReadStream(filePath).on('error', () => {
    if (!res.headersSent) sendText(res, 500, 'Unable to read file.');
    else res.destroy();
  }).pipe(res);
}

const server = http.createServer((req, res) => {
  serveRequest(req, res).catch(() => {
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    else res.destroy();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Star Follower running on port ${PORT}`);
});
