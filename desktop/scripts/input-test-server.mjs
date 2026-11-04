import http from 'node:http';
import { readFile } from 'node:fs/promises';

const routes = new Map([
  ['/webkit-input.js', ['../../panel/web/public/webkit-input.js', 'text/javascript']],
  ['/desktop/test/vnc/index.html', ['../tests-webkit/fixtures/remote-input.html', 'text/html']],
  ['/events.js', ['../tests-webkit/fixtures/novnc/events.js', 'text/javascript']],
]);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:19445');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head>${url.searchParams.get('guard') === 'off' ? '' : '<script src="/webkit-input.js"></script>'}</head>
      <body><input aria-label="面板输入"><iframe id="remote" style="display:block;width:700px;height:480px" src="/desktop/test/vnc/index.html"></iframe></body></html>`);
  } else if (url.pathname === '/api/instances/test/clientlog') {
    req.resume();
    res.end('{}');
  } else if (routes.has(url.pathname)) {
    try {
      const [file, mime] = routes.get(url.pathname);
      res.setHeader('Content-Type', `${mime}; charset=utf-8`);
      res.end(await readFile(new URL(file, import.meta.url)));
    } catch (error) { res.writeHead(500).end(String(error)); }
  } else { res.writeHead(404).end(); }
}).listen(19445, '127.0.0.1');
