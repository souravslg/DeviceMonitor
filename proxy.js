/**
 * NetWatch Local Proxy Server
 * - Serves index.html / style.css / app.js at http://localhost:5500/
 * - Proxies UPS device requests at /proxy?url=http://[UPS-IP]/
 *   so the browser can read UPS data without CORS errors.
 *
 * Run: node proxy.js
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = 5500;
const DIR  = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.ico' : 'image/x-icon',
};

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ===== PROXY HANDLER =====
function handleProxy(req, res, targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch {
    res.writeHead(400, CORS);
    res.end(JSON.stringify({ error: 'Invalid target URL' }));
    return;
  }

  const options = {
    hostname: parsed.hostname,
    port    : parseInt(parsed.port) || 80,
    path    : parsed.pathname + parsed.search,
    method  : 'GET',
    headers : { 'User-Agent': 'NetWatch-Proxy/1.0', 'Connection': 'close' },
    timeout : 6000,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = {
      ...CORS,
      'Content-Type': proxyRes.headers['content-type'] || 'text/html',
    };
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, CORS);
    res.end(JSON.stringify({ error: 'Gateway timeout' }));
  });

  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  proxyReq.end();
}

// ===== STATIC FILE HANDLER =====
function handleStatic(req, res, pathname) {
  const filePath = path.join(DIR, pathname === '/' ? 'index.html' : pathname);
  const ext      = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', ...CORS });
    res.end(data);
  });
}

// ===== SERVER =====
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // Proxy endpoint: GET /proxy?url=http://100.67.75.166/
  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, CORS);
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
      return;
    }
    handleProxy(req, res, target);
    return;
  }

  // API Endpoints for saving/loading data
  if (pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      fs.writeFile(path.join(DIR, 'devices.json'), body, (err) => {
        if (err) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ success: true }));
        }
      });
    });
    return;
  }

  if (pathname === '/api/load' && req.method === 'GET') {
    fs.readFile(path.join(DIR, 'devices.json'), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(200, CORS);
        res.end(JSON.stringify([]));
      } else {
        res.writeHead(200, CORS);
        res.end(data);
      }
    });
    return;
  }

  // Static files
  handleStatic(req, res, pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║       NetWatch Proxy Server Running      ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Dashboard  →  http://localhost:${PORT}/     ║`);
  console.log(`  ║  Proxy API  →  /proxy?url=http://[IP]/   ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Open http://localhost:5500 in your browser.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use. Stop the other process and retry.\n`);
  } else {
    console.error('\n  Server error:', e.message, '\n');
  }
  process.exit(1);
});
