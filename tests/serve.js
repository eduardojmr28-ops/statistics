// Local preview of web/: node tests/serve.js  ->  http://localhost:5180
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'web');
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// Same Content-Security-Policy that netlify.toml sends for /carga/, so a policy that breaks the page shows up locally.
const csp = (fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "(.*)"/) || [])[1];
http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]), f = path.join(root, p.endsWith('/') ? p + 'index.html' : p);
  if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const h = { 'content-type': tipos[path.extname(f)] || 'application/octet-stream' };
    if (csp && p.startsWith('/carga/')) h['content-security-policy'] = csp;
    r.writeHead(200, h); r.end(d); });
}).listen(5180);
