const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const APK_DOWNLOAD_URL = 'https://drive.usercontent.google.com/download?id=1aWkp8uCJ18OmKfXViYvgImfG_blyXFGL&export=download&confirm=t';

// Proxy the APK through this app so the browser receives a same-origin
// attachment response instead of Google Drive's confirmation page.
app.get('/download/star-follower.apk', async (req, res) => {
  try {
    const upstream = await fetch(APK_DOWNLOAD_URL, {
      redirect: 'follow',
      headers: { Accept: 'application/vnd.android.package-archive,application/octet-stream' },
    });

    if (!upstream.ok || !upstream.body) {
      res.status(502).type('text').send('APK download is temporarily unavailable.');
      return;
    }

    res.status(200);
    res.set('Content-Type', 'application/vnd.android.package-archive');
    res.set('Content-Disposition', 'attachment; filename="star-follower.apk"');
    if (upstream.headers.get('content-length')) {
      res.set('Content-Length', upstream.headers.get('content-length'));
    }
    res.set('Cache-Control', 'no-store');
    res.flushHeaders();
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    res.status(502).type('text').send('APK download is temporarily unavailable.');
  }
});

// Serve static files from workspace root
app.use(express.static(__dirname, {
  // Don't set cache headers here — we'll handle them manually
  etag: true,
  lastModified: true,
}));

// Apply custom cache headers matching _headers file
app.use((req, res, next) => {
  const noCache = ['/index.html', '/sw.js', '/manifest.json', '/supabase-api.js', '/'];
  const p = req.path;

  if (noCache.includes(p) || p === '/') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  } else if (p.startsWith('/assets/')) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// SPA fallback — all routes serve index.html (mirrors _redirects: /* /index.html 200)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Star Follower running on port ${PORT}`);
});
