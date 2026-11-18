from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import json
import os
import ssl

ROOT = Path(os.environ['WOC_FINDER_FIXTURE'])
class Handler(BaseHTTPRequestHandler):
    def response(self, status, content, mime='text/plain'):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/':
            data = b'<html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe src="/frame"></iframe><script src="/entry.js"></script></html>'
            return self.response(200, data, 'text/html')
        if path == '/frame':
            return self.response(200, b'<html><body style="margin:0;background:#def;height:100vh"><div style="padding:50px">Drag this file to Finder</div></body></html>', 'text/html')
        if path == '/entry.js':
            return self.response(200, (ROOT / 'entry.js').read_bytes(), 'application/javascript')
        if path == '/api/instances/aabbcc1234/drag-download':
            if self.headers.get('x-woc-file-ticket') != 'A' * 43:
                return self.response(403, b'bad ticket')
            (ROOT / 'download-requested').write_text('yes')
            return self.response(200, b'woc-finder-integration-content\n')
        if path == '/error':
            (ROOT / 'error').write_text(self.path)
            return self.response(200, b'ok')
        return self.response(404, b'not found')
    def do_POST(self):
        path = urlsplit(self.path).path
        if path in ('/ready', '/release'):
            (ROOT / path[1:]).write_text('yes')
            return self.response(200, b'ok')
        return self.response(404, b'not found')
    def log_message(self, fmt, *args):
        pass
cert = os.environ.get('WOC_FINDER_TLS_CERT')
server = ThreadingHTTPServer(('127.0.0.1', 443 if cert else 19495), Handler)
if cert:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, os.environ['WOC_FINDER_TLS_KEY'])
    server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()

