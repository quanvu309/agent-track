"""HTTP server: static page, JSON API over read-only connections, the ingest writer and the machine sampler."""

import json
import re
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import presence, queries, store
from .adapters import Cap, load_adapters, resolve_homes
from .machine import Sampler
from .platform import Env

STATIC = Path(__file__).resolve().parent / "static"
INTERVAL_SECONDS = 60

# Vite writes content-hashed names into static/assets, so a file under one name never changes.
ASSET_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
IMMUTABLE = "public, max-age=31536000, immutable"


def _asset(static: Path, name: str) -> tuple[bytes, str] | None:
    """Exact file name inside static/assets. Anything with a separator, an escape, or '..' is not an asset name."""
    content_type = ASSET_TYPES.get(Path(name).suffix)
    if content_type is None or not ASSET_NAME.match(name) or ".." in name:
        return None
    path = static / "assets" / name
    return (path.read_bytes(), content_type) if path.is_file() else None


class Ingestor:
    """Single writer. The lock serializes the background loop and POST /api/ingest."""

    def __init__(self, db_path, homes=None, log=lambda msg: print(msg, file=sys.stderr), adapters=None, env: Env | None = None):
        self.db_path, self.homes, self.log = db_path, homes, log
        self.adapters = load_adapters() if adapters is None else adapters
        self.env = env or Env.current()
        self.lock = threading.Lock()
        self.running = False
        self._stop = threading.Event()

    def run(self) -> dict:
        with self.lock:
            self.running = True
            conn = store.connect(self.db_path)
            try:
                return store.ingest(conn, self.homes, self.log, self.adapters, self.env)
            finally:
                conn.close()
                self.running = False

    def loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run()
            except Exception as exc:
                self.log(f"ingest failed: {exc!r}")
            self._stop.wait(INTERVAL_SECONDS)

    def start(self) -> None:
        threading.Thread(target=self.loop, name="ingest", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()


class BadRequest(Exception):
    pass


def _limit(params: dict, default: int, cap: int = 1000) -> int:
    try:
        return max(1, min(cap, int(params.get("limit", default))))
    except ValueError:
        raise BadRequest("limit must be an integer")


DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _range(params: dict) -> queries.Range:
    since, until = params.get("since") or None, params.get("until") or None
    for value in (since, until):
        if value is not None and not DATE.match(value):
            raise BadRequest("since and until must be YYYY-MM-DD")
    return queries.Range(since, until)


def _day(params: dict) -> str | None:
    value = params.get("day") or None
    if value is not None and not DATE.match(value):
        raise BadRequest("day must be YYYY-MM-DD")
    return value


def _harness(ctx, params: dict) -> str | None:
    value = params.get("harness") or None
    if value is not None and value not in {a.id for a in ctx.ingestor.adapters if Cap.INGEST in a.capabilities}:
        raise BadRequest(f"unknown harness {value!r}")
    return value


# (method, path pattern) -> handler(ctx, params, *path groups). ctx exposes a read connection and the ingestor.
def _summary(ctx, params):
    return {**queries.summary(ctx.conn, _range(params)), "ingesting": ctx.ingestor.running}


def _session(ctx, params, session_id):
    found = queries.session(ctx.conn, unquote(session_id))
    if found is None:
        raise LookupError(session_id)
    row = found["session"]
    row["thread_rows"] = found["threads"]  # apply() reads thread_rows; the thread dicts are shared with found["threads"]
    presence.apply([row], ctx.presence)
    del row["thread_rows"]
    return found


def _sessions(ctx, params):
    rows = queries.sessions(ctx.conn, _harness(ctx, params), params.get("project") or None, _limit(params, 50), _range(params), (params.get("q") or "").strip()[:100] or None)
    return presence.apply(rows, ctx.presence)


def _ingest(ctx, params):
    stats = ctx.ingestor.run()
    return {"stats": stats, "totals": queries.totals(ctx.conn)}


def _minutes(params: dict, default: int = 15, cap: int = 1440) -> int:
    try:
        return max(1, min(cap, int(params.get("minutes", default))))
    except ValueError:
        raise BadRequest("minutes must be an integer")


def _bucket(params: dict) -> int:
    value = params.get("bucket", "5")
    if value not in {str(b) for b in queries.BURN_BUCKETS}:
        raise BadRequest(f"bucket must be one of {', '.join(map(str, queries.BURN_BUCKETS))}")
    return int(value)


def _machine(ctx, params):
    return {"available": ctx.sampler is not None, "now": ctx.sampler.latest if ctx.sampler else None, **queries.machine_series(ctx.conn, _minutes(params, 60, 10080))}


ROUTES = [
    ("GET", re.compile(r"^/api/summary$"), _summary),
    ("GET", re.compile(r"^/api/daily$"), lambda ctx, p: queries.daily(ctx.conn)),
    ("GET", re.compile(r"^/api/today$"), lambda ctx, p: queries.hourly(ctx.conn, _day(p))),
    ("GET", re.compile(r"^/api/models$"), lambda ctx, p: queries.models(ctx.conn, _range(p))),
    ("GET", re.compile(r"^/api/tools$"), lambda ctx, p: queries.tools(ctx.conn, _harness(ctx, p), _limit(p, 20), _range(p))),
    ("GET", re.compile(r"^/api/reliability$"), lambda ctx, p: queries.reliability(ctx.conn, _harness(ctx, p), _limit(p, 15), _range(p))),
    ("GET", re.compile(r"^/api/heatmap$"), lambda ctx, p: queries.heatmap(ctx.conn, _harness(ctx, p), _range(p))),
    ("GET", re.compile(r"^/api/live$"), lambda ctx, p: presence.apply(queries.live(ctx.conn, _minutes(p)), ctx.presence)),
    ("GET", re.compile(r"^/api/burn$"), lambda ctx, p: queries.burn(ctx.conn, _minutes(p, 120, 2880), _bucket(p), _harness(ctx, p))),
    ("GET", re.compile(r"^/api/machine$"), _machine),
    ("GET", re.compile(r"^/api/projects$"), lambda ctx, p: queries.projects(ctx.conn, _harness(ctx, p), _limit(p, 200), _range(p))),
    ("GET", re.compile(r"^/api/sessions$"), _sessions),
    ("GET", re.compile(r"^/api/session/([^/]+)$"), _session),
    ("POST", re.compile(r"^/api/ingest$"), _ingest),
]


class Context:
    def __init__(self, db_path, ingestor, sampler=None, scan=presence.scan):
        self.ingestor, self.sampler, self._scan = ingestor, sampler, scan
        self._presence = None
        self.conn = store.connect(db_path, readonly=True)

    @property
    def presence(self) -> presence.Presence:
        """One presence scan per request, taken on first use."""
        if self._presence is None:
            try:
                self._presence = self._scan(
                    self.ingestor.adapters, resolve_homes(self.ingestor.adapters, self.ingestor.env, self.ingestor.homes), self.ingestor.env.probe)
            except Exception as exc:
                print(f"presence scan failed: {exc!r}", file=sys.stderr)
                self._presence = presence.Presence({}, {}, frozenset())
        return self._presence

    def close(self):
        self.conn.close()


LOOPBACK_NAMES = {"127.0.0.1", "localhost", "::1"}


def host_allowed(header: str | None, port: int) -> bool:
    """DNS rebinding guard: a rebound page still sends its own hostname in Host."""
    if not header:
        return False
    try:
        parsed = urlparse("//" + header)
        return parsed.hostname in LOOPBACK_NAMES and (parsed.port or 80) == port
    except ValueError:
        return False


def same_origin(origin: str | None, host: str | None) -> bool:
    return origin is None or urlparse(origin).netloc == (host or "")


def make_handler(db_path, ingestor, static: Path = STATIC, sampler=None, scan=presence.scan, allow_remote=False):
    class Handler(BaseHTTPRequestHandler):
        server_version = "agenttrack"

        def log_message(self, fmt, *args):
            pass

        def _send(self, status, body: bytes, content_type: str, cache: str = "no-store"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status, payload):
            self._send(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

        def _dispatch(self, method):
            url = urlparse(self.path)
            host = self.headers.get("Host")
            if not allow_remote and not host_allowed(host, self.server.server_address[1]):
                return self._json(403, {"error": "forbidden host"})
            if method == "POST" and not same_origin(self.headers.get("Origin"), host):
                return self._json(403, {"error": "cross-origin request refused"})
            if method == "GET" and url.path in ("/", "/index.html"):
                index = static / "index.html"
                if not index.is_file():
                    return self._send(503, b"agent-track UI is not built. Run `pnpm install && pnpm build` in web/, or install the agent-track-cli wheel from PyPI.\n", "text/plain; charset=utf-8")
                return self._send(200, index.read_bytes(), "text/html; charset=utf-8")
            if method == "GET" and url.path.startswith("/assets/"):
                found = _asset(static, url.path.removeprefix("/assets/"))
                return self._send(200, found[0], found[1], IMMUTABLE) if found else self._json(404, {"error": "not found"})
            params = {k: v[-1] for k, v in parse_qs(url.query).items()}
            for route_method, pattern, handler in ROUTES:
                match = pattern.match(url.path)
                if match and route_method == method:
                    ctx = Context(db_path, ingestor, sampler, scan)
                    try:
                        return self._json(200, handler(ctx, params, *match.groups()))
                    except BadRequest as exc:
                        return self._json(400, {"error": str(exc)})
                    except LookupError:
                        return self._json(404, {"error": "not found"})
                    except Exception as exc:
                        print(f"{method} {self.path} failed: {exc!r}", file=sys.stderr)
                        return self._json(500, {"error": "internal error"})
                    finally:
                        ctx.close()
            self._json(404, {"error": "not found"})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

    return Handler


class _Server(ThreadingHTTPServer):
    def __init__(self, addr, handler):
        if ":" in addr[0]:
            self.address_family = socket.AF_INET6
        super().__init__(addr, handler)


def make_server(host, port, db_path, ingestor, static: Path = STATIC, sampler=None, scan=presence.scan, allow_remote=False) -> ThreadingHTTPServer:
    store.connect(db_path).close()
    server = _Server((host, port), make_handler(db_path, ingestor, static, sampler, scan, allow_remote))
    server.daemon_threads = True
    return server


def serve(host: str, port: int, db_path, env: Env | None = None, adapters=None, homes=None, allow_remote=False) -> None:
    env = env or Env.current()
    adapters = load_adapters() if adapters is None else adapters
    ingestor = Ingestor(db_path, homes, adapters=adapters, env=env)
    sampler = Sampler(db_path, env.probe, env.metrics, adapters) if env.metrics.available and env.probe.available else None
    server = make_server(host, port, db_path, ingestor, sampler=sampler, allow_remote=allow_remote)
    if sampler:
        sampler.start()
    ingestor.start()
    print(f"agent-track listening on http://{host}:{server.server_address[1]}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        ingestor.stop()
        if sampler:
            sampler.stop()
        server.server_close()
