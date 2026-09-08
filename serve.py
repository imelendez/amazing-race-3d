#!/usr/bin/env python3
"""Tiny static server for local dev: python3 serve.py [port]

Also accepts POST /__capture?name=foo.png with a data: URL body and writes it to
docs/ — used to grab canvas screenshots for the README without a screen recorder.
"""
import base64, functools, http.server, os, re, socketserver, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if not self.path.startswith("/__capture"):
            return self.send_error(404)
        name = re.search(r"name=([\w.\-]+)", self.path)
        name = name.group(1) if name else "capture.png"
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        payload = body.split(",", 1)[1] if body.startswith("data:") else body
        docs = os.path.join(ROOT, "docs")
        os.makedirs(docs, exist_ok=True)
        path = os.path.join(docs, name)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(payload))
        sys.stderr.write("captured docs/%s (%d bytes)\n" % (name, os.path.getsize(path)))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)) as httpd:
    print("serving %s at http://127.0.0.1:%d/" % (ROOT, PORT), flush=True)
    httpd.serve_forever()
