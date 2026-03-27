// serve-admin.js
// Запусти: node serve-admin.js
// Потом открой: http://localhost:8080/admin.html

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const DIR = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
};

http.createServer((req, res) => {
  let filePath = path.join(DIR, req.url === '/' ? '/admin.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`✅ Admin panel: http://localhost:${PORT}/admin.html`);
  console.log('   Press Ctrl+C to stop');
});
