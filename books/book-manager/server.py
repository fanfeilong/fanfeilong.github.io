#!/usr/bin/env python3
"""Loopback library review server. Source documents are never modified."""

from __future__ import annotations

import argparse
import hashlib
import datetime
import math
import threading
import time
import json
import mimetypes
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
APP = Path(__file__).resolve().parent
ALLOWED = {".pdf", ".docx", ".pptx", ".ppt", ".md", ".png", ".jpg", ".jpeg", ".mhtml", ".doc", ".txt", ".epub", ".webp", ".xls", ".xlsx"}
RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


def in_root(path: Path) -> bool:
    return path == ROOT or ROOT in path.parents


COURSE_SECTIONS = ('课程概览', '学习目标', '课程安排', '考核与作业', '学习资源', '信息缺口', '来源')


def parse_course(text):
    """Parse the JSON-compatible YAML front matter used by course/v1."""
    match = re.fullmatch(r'---\r?\n(.*?)\r?\n---(?:\r?\n|$)(.*)', text.lstrip('\ufeff'), re.S)
    if not match:
        raise ValueError('Course Markdown needs JSON front matter between --- lines')
    metadata = json.loads(match.group(1))
    required = ('schema_version', 'id', 'title', 'source_url', 'summary', 'last_checked')
    if not isinstance(metadata, dict) or any(not isinstance(metadata.get(key), str) or not metadata[key].strip() for key in required):
        raise ValueError('Course requires non-empty schema_version, id, title, source_url, summary and last_checked')
    if metadata['schema_version'] != 'course/v1' or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', metadata['id']):
        raise ValueError('Unsupported course schema or invalid course id')
    optional_strings = ('provider', 'title_zh', 'term', 'language', 'delivery', 'location', 'schedule', 'credit_unit', 'prerequisites', 'enrollment', 'cost', 'certificate', 'license')
    for key in optional_strings:
        if key not in metadata or (metadata[key] is not None and not isinstance(metadata[key], str)):
            raise ValueError(f'Course field {key} must be a string or null')
    for key in ('course_codes', 'instructors', 'topics'):
        if not isinstance(metadata.get(key), list) or any(not isinstance(item, str) or not item.strip() for item in metadata[key]):
            raise ValueError(f'Course field {key} must be an array of strings')
    for key in ('year', 'credits', 'weekly_hours'):
        value = metadata.get(key)
        if key not in metadata or (value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0)):
            raise ValueError(f'Course field {key} must be a non-negative number or null')
    if metadata['year'] is not None and (type(metadata['year']) is not int or not 1900 <= metadata['year'] <= 2100):
        raise ValueError('Course year must be an integer in 1900..2100 or null')
    def valid_url(url):
        return isinstance(url, str) and urlsplit(url).scheme in ('https', 'http') and bool(urlsplit(url).hostname)
    if not valid_url(metadata['source_url']):
        raise ValueError('Course source_url must be an HTTP(S) URL')
    datetime.date.fromisoformat(metadata['last_checked'])
    sources = metadata.get('sources')
    if not isinstance(sources, list) or not sources:
        raise ValueError('Course sources must include at least the course homepage')
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get('title'), str) or not source['title'].strip() or not valid_url(source.get('url')):
            raise ValueError('Course sources require title, HTTP(S) url and checked_at')
        datetime.date.fromisoformat(source['checked_at'])
    if metadata['source_url'].rstrip('/') not in {source['url'].rstrip('/') for source in sources}:
        raise ValueError('Course sources must cite source_url')
    body = match.group(2).strip()
    for section in COURSE_SECTIONS:
        if not re.search(r'^## ' + re.escape(section) + r'\s*$', body, re.M):
            raise ValueError(f'Course body is missing section: {section}')
    return metadata, body


def books():
    result = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in ALLOWED:
            continue
        if not in_root(path.resolve()) or APP in path.parents or any(part.startswith(".") for part in path.relative_to(ROOT).parts):
            continue
        relative = path.relative_to(ROOT)
        stat = path.stat()
        result.append({
            "path": relative.as_posix(),
            "name": path.stem,
            "extension": path.suffix.lower()[1:],
            "category": relative.parts[0] if len(relative.parts) > 1 else "根目录",
            "topic": relative.parts[1] if len(relative.parts) > 2 else "未分类",
            "size": stat.st_size,
            "modified": int(stat.st_mtime),
        })
        if relative.parts[0] == '07_课程' and path.suffix.lower() == '.md':
            metadata, _ = parse_course(path.read_text(encoding='utf-8'))
            result[-1]['course'] = metadata
            title = metadata['title_zh'] or metadata['title']
            result[-1]['name'] = f"{title} · {metadata['year']}" if metadata['year'] else title
    return sorted(result, key=lambda item: item["path"].casefold())


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.handle_request(False)

    def do_HEAD(self):
        self.handle_request(True)

    def handle_request(self, head_only: bool):
        host = self.headers.get("Host", "")
        if host not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            return self.send_error(403)
        url_path = urlsplit(self.path).path
        # Local mode serves the same static artifact as Pages. Only review APIs
        # are local; there is deliberately no filesystem deletion endpoint.
        if url_path == "/books/book-manager/books.json":
            return self.send_json({"books": catalog(), "localMode": True}, head_only)
        if url_path in {"/api/review", "/api/review/export"}:
            with REVIEW_LOCK:
                data = review_snapshot()
            return self.send_json(data, head_only, download=url_path.endswith("/export"))
        # Read marked documents from their original location, not a build copy.
        current_books = catalog()
        source_files = {"/" + (Path("books") / book["path"]).as_posix(): (ROOT / book["path"]).resolve() for book in current_books if not book["path"].startswith("../")}
        source_files.update({"/" + Path(book["path"]).name: (ROOT / book["path"]).resolve() for book in current_books if book["path"].startswith("../")})
        if unquote(url_path) in source_files:
            return self.send_file(source_files[unquote(url_path)], head_only)
        static = "index.html" if url_path == "/" else unquote(url_path.lstrip("/"))
        candidate = (DIST / static).resolve()
        if DIST not in candidate.parents or any(part.startswith(".") for part in Path(static).parts):
            self.send_error(404)
            return
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file():
            self.send_error(404)
            return
        self.send_file(candidate, head_only)

    def send_json(self, data, head_only=False, download=False):
        payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if download:
            self.send_header("Content-Disposition", 'attachment; filename="library-review.json"')
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)

    def do_POST(self):
        host = self.headers.get("Host", "")
        if (host not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
                or self.headers.get("X-Book-Review") != "1"
                or self.headers.get("Origin", f"http://{host}") != f"http://{host}"):
            return self.send_error(403)
        if urlsplit(self.path).path != "/api/review":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                return self.send_error(400)
            payload = json.loads(self.rfile.read(length))
            name, choice = payload["path"], payload["choice"]
            current = {item["path"]: item for item in catalog()}
            if name not in current or choice not in {"keep", "discard", "unreviewed"}:
                return self.send_error(400)
            path = (ROOT / name).resolve()
            with REVIEW_LOCK:
                reviews = read_reviews()
                if choice == "unreviewed":
                    reviews.pop(name, None)
                else:
                    stat = path.stat()
                    with path.open("rb") as stream:
                        digest = hash_stream(stream)
                    if (stat.st_size, stat.st_mtime_ns) != (path.stat().st_size, path.stat().st_mtime_ns):
                        return self.send_error(409, "File changed while marking; retry")
                    reviews[name] = {"choice": choice, "size": stat.st_size,
                                     "mtime_ns": stat.st_mtime_ns, "sha256": digest, "marked_at": int(time.time())}
                STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
                temporary = STATE_FILE.with_suffix(".tmp")
                temporary.write_text(json.dumps({"reviews": reviews}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                temporary.chmod(0o600)
                os.replace(temporary, STATE_FILE)
                data = review_snapshot()
            self.send_json(data)
        except (ValueError, KeyError, TypeError):
            self.send_error(400)
        except OSError:
            self.send_error(500, "Cannot save review records")

    def send_file(self, path: Path, head_only: bool = False):
        size = path.stat().st_size
        start, end = 0, size - 1
        partial = False
        requested = self.headers.get("Range")
        if requested:
            match = RANGE.fullmatch(requested.strip())
            if not match or not match.group(1) and not match.group(2):
                self.send_error(416)
                return
            if match.group(1):
                start = int(match.group(1))
                end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            else:
                length = int(match.group(2))
                start = max(0, size - length)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            partial = True
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() == ".pdf":
            content_type = "application/pdf"
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Disposition", "inline")
        self.send_header("X-Content-Type-Options", "nosniff")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only:
            return
        try:
            with path.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


# Public catalog includes the original root-level reading materials as well.
SITE = ROOT.parent
DIST = SITE / "dist"
REVIEW_LOCK = threading.Lock()
STATE_FILE = None


def resource_entries():
    registry = APP / "resources.json"
    if not registry.is_file():
        return []
    entries = json.loads(registry.read_text(encoding="utf-8"))["resources"]
    ids, paths = set(), set()
    for entry in entries:
        identifier, path = entry["id"], entry["path"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", identifier) or identifier in ids or path in paths:
            raise ValueError("Resource IDs and paths must be unique; IDs use lowercase letters, digits and hyphens")
        ids.add(identifier)
        paths.add(path)
    return entries


def catalog():
    result = [item for item in books() if item["path"] != "分类索引.md"]
    for path in SITE.iterdir():
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in {".pdf", ".pptx", ".docx", ".doc", ".ppt"}:
            stat = path.stat()
            result.append({"path": "../" + path.name, "name": path.stem,
                           "extension": path.suffix.lower()[1:], "category": "历史资料",
                           "topic": "旧站收藏", "size": stat.st_size, "modified": int(stat.st_mtime)})
    ids = {entry["path"]: entry["id"] for entry in resource_entries()}
    for book in result:
        if book.get('course') and book['path'] in ids and book['course']['id'] != ids[book['path']]:
            raise ValueError(f"Course id differs from resource registry: {book['path']}")
    return sorted(({**book, "id": ids.get(book["path"])} for book in result), key=lambda item: item["path"].casefold())


def hash_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def read_reviews():
    if not STATE_FILE.exists():
        return {}
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))["reviews"]


def review_snapshot():
    reviews = read_reviews()
    current = {book["path"]: book for book in catalog()}
    for name, review in reviews.items():
        path = (ROOT / name).resolve()
        review["stale"] = name not in current or not path.is_file() or review["size"] != path.stat().st_size or review["mtime_ns"] != path.stat().st_mtime_ns
    return {"reviews": reviews}


def main():
    global STATE_FILE
    parser = argparse.ArgumentParser(description="Local library review server; never deletes source files.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--state-file", type=Path)
    args = parser.parse_args()
    identity = hashlib.sha256(str(SITE).encode()).hexdigest()[:12]
    STATE_FILE = (args.state_file or Path.home() / ".local/state/fanfeilong-library" / (identity + ".json")).resolve()
    if not (DIST / "index.html").is_file():
        raise SystemExit("Run npm ci && npm run build at the repository root first.")
    print(f"灰库: http://127.0.0.1:{args.port}/", flush=True)
    print(f"Review records: {STATE_FILE}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
