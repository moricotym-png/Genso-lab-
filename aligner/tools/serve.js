// 簡易ローカルサーバー（ES モジュールと Web Worker は file:// では動かないため）
// 使い方: node tools/serve.js [port]  → http://localhost:8080/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.stl': 'model/stl' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[エラー] ポート ${port} は使用中です。前に起動した Aligner Studio がまだ動いています。`);
    console.error('前のターミナルで control + C を押して止めるか、そのターミナルを閉じてから、もう一度 npm start してください。\n');
  } else console.error(e);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Aligner Studio: http://localhost:${port}/`);
  console.log(`起動したフォルダ: ${root}`);
});
