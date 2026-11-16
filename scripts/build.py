#!/usr/bin/env python3
"""Produce a self-contained GitHub Pages artifact; never alter source books."""
import argparse
import hashlib
import html
import importlib.util
import json
import shutil
import uuid
from urllib.parse import quote
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist'
APP = ROOT / 'books/book-manager'
spec = importlib.util.spec_from_file_location('library', APP / 'server.py')
library = importlib.util.module_from_spec(spec)
spec.loader.exec_module(library)


def sync_resources():
    entries = library.resource_entries()
    registered = {entry['path'] for entry in entries}
    for book in library.catalog():
        if book['path'] not in registered:
            entries.append({'id': 'book-' + uuid.uuid4().hex[:12], 'path': book['path']})
    registry = {'version': 1, 'resources': entries}
    (APP / 'resources.json').write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n')


def resource_page(template, entry, book):
    title = book['name'] if book else Path(entry['path']).stem
    description = f"{title} · 灰库在线阅读" if book else '这份资源已不可用，可返回灰库查看其他资料。'
    canonical = f"https://fanfeilong.github.io/read/{entry['id']}/"
    page = template.replace('<head>', '<head>\n  <base href="../../">', 1)
    page = page.replace('<title>灰库 · Fan Feilong</title>', f'<title>{html.escape(title)} · 灰库</title>')
    page = page.replace('</head>', f'<link rel="canonical" href="{canonical}">\n  <meta property="og:type" content="article">\n  <meta property="og:title" content="{html.escape(title, quote=True)}">\n  <meta property="og:description" content="{html.escape(description, quote=True)}">\n  <meta property="og:url" content="{canonical}">\n</head>', 1)
    start = page.index('<meta name="description"')
    end = page.index('>', start) + 1
    page = page[:start] + f'<meta name="description" content="{html.escape(description, quote=True)}">' + page[end:]
    if book:
        original = quote('books/' + book['path'], safe='/')
        page = page.replace('<noscript>', f'<noscript>{html.escape(title)}：<a href="{html.escape(original, quote=True)}">打开原文件</a>。', 1)
    return page


def build():
    pdfjs = ROOT / 'node_modules/pdfjs-dist'
    if not (pdfjs / 'build/pdf.mjs').is_file():
        raise SystemExit('Missing PDF.js: run npm ci with Node >=22.13 first.')
    books = library.catalog()
    if any(not book['id'] for book in books):
        raise SystemExit('Unregistered resources: run python3 scripts/build.py --sync-resources and commit resources.json.')
    catalog = {'books': books}
    catalog_text = json.dumps(catalog, ensure_ascii=False, indent=2) + '\n'
    template = (ROOT / 'index.html').read_text()
    script = (APP / 'app.js').read_bytes()
    stylesheet = (APP / 'style.css').read_bytes()
    revision = hashlib.sha256(template.encode() + script + stylesheet + catalog_text.encode()).hexdigest()[:16]
    template = template.replace('books/book-manager/app.js', f'books/book-manager/app.{revision}.js')
    template = template.replace('books/book-manager/style.css', f'books/book-manager/style.{revision}.css')
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    # Publish only the library shell and the documents in its catalog.
    (OUT / 'index.html').write_text(template)
    dest = OUT / 'books/book-manager'
    dest.mkdir(parents=True)
    for name in ('index.html', 'app.js', 'style.css', 'favicon.svg'):
        shutil.copy2(APP / name, dest / name)
    # Keep compatibility names for previously cached HTML; new pages use fingerprints.
    (dest / f'app.{revision}.js').write_bytes(script)
    (dest / f'style.{revision}.css').write_bytes(stylesheet)
    current = {book['id']: book for book in books}
    for entry in library.resource_entries():
        target = OUT / 'read' / entry['id'] / 'index.html'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(resource_page(template, entry, current.get(entry['id'])))
    (OUT / '404.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>资源不存在 · 灰库</title><h1>资源不存在或已移除</h1><p><a href="/">返回灰库</a></p></html>')
    for book in books:
        source = ROOT / 'books' / book['path']
        if source.stat().st_size >= 100 * 1024**2:
            raise SystemExit(f'File exceeds GitHub upload limit: {source}')
        target = OUT / 'books' / book['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(ROOT / 'books/分类索引.md', OUT / 'books/分类索引.md')
    (dest / 'books.json').write_text(catalog_text)
    vendor = dest / 'vendor/pdfjs'
    for directory in ('build', 'cmaps', 'standard_fonts', 'wasm'):
        shutil.copytree(pdfjs / directory, vendor / directory, ignore=shutil.ignore_patterns('*.map', '*.d.ts'))
    shutil.copy2(pdfjs / 'LICENSE', vendor / 'LICENSE')
    (OUT / '.nojekyll').touch()
    size = sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())
    if size >= 1_000_000_000:
        raise SystemExit(f'Pages artifact exceeds 1 GB budget: {size:,} bytes')
    print(f'Built {len(books)} library files, {len(set(b["category"] for b in books))} categories; artifact {size / 1e6:.1f} MB → {OUT}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--sync-resources', action='store_true', help='Register new paths once; preserve IDs when moving existing files')
    if parser.parse_args().sync_resources:
        sync_resources()
    build()
