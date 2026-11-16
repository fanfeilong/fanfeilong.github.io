#!/usr/bin/env python3
"""Produce a self-contained GitHub Pages artifact; never alter source books."""
import importlib.util
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist'
APP = ROOT / 'books/book-manager'
spec = importlib.util.spec_from_file_location('library', APP / 'server.py')
library = importlib.util.module_from_spec(spec)
spec.loader.exec_module(library)


def build():
    pdfjs = ROOT / 'node_modules/pdfjs-dist'
    if not (pdfjs / 'build/pdf.mjs').is_file():
        raise SystemExit('Missing PDF.js: run npm ci with Node >=22.13 first.')
    books = library.catalog()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    # Publish only the library shell and the documents in its catalog.
    shutil.copy2(ROOT / 'index.html', OUT / 'index.html')
    dest = OUT / 'books/book-manager'
    dest.mkdir(parents=True)
    for name in ('index.html', 'app.js', 'style.css', 'favicon.svg'):
        shutil.copy2(APP / name, dest / name)
    for book in books:
        source = ROOT / 'books' / book['path']
        if source.stat().st_size >= 100 * 1024**2:
            raise SystemExit(f'File exceeds GitHub upload limit: {source}')
        target = OUT / 'books' / book['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(ROOT / 'books/分类索引.md', OUT / 'books/分类索引.md')
    catalog = {'books': books}
    (dest / 'books.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
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
    build()
