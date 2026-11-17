#!/usr/bin/env python3
"""Fetch course evidence, create course/v1 Markdown, and validate it."""
import argparse
import datetime
import importlib.util
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


class Evidence(HTMLParser):
    def __init__(self, base):
        super().__init__()
        self.base, self.text, self.links = base, [], []
        self.skip, self.href, self.label, self.in_title, self.title = 0, None, [], False, []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if tag == 'title':
            self.in_title = True
        if tag == 'a':
            self.href = dict(attrs).get('href')
            self.label = []
        if tag in ('p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'tr'):
            self.text.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        if tag == 'title':
            self.in_title = False
        if tag == 'a' and self.href:
            url = urljoin(self.base, self.href)
            if urlsplit(url).scheme in ('https', 'http'):
                self.links.append({'text': ' '.join(' '.join(self.label).split()), 'url': url})
            self.href = None
        if tag in ('p', 'div', 'li', 'h1', 'h2', 'h3', 'tr'):
            self.text.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.text.append(data)
            if self.href:
                self.label.append(data)
            if self.in_title:
                self.title.append(data)


def repo_root():
    for root in (Path.cwd(), *Path.cwd().parents):
        if (root / 'books/book-manager/server.py').is_file() and (root / 'scripts/build.py').is_file():
            return root
    raise ValueError('Run from this repository or one of its subdirectories')


def library(root):
    spec = importlib.util.spec_from_file_location('course_library', root / 'books/book-manager/server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(url):
    return url.split('#', 1)[0].rstrip('/')


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    fetch = commands.add_parser('fetch'); fetch.add_argument('url')
    validate = commands.add_parser('validate'); validate.add_argument('path', type=Path)
    create = commands.add_parser('create')
    create.add_argument('--spec', type=Path, required=True); create.add_argument('--body', type=Path, required=True)
    create.add_argument('--topic', required=True); create.add_argument('--update', action='store_true')
    args = parser.parse_args()
    if args.command == 'fetch':
        if urlsplit(args.url).scheme not in ('http', 'https'):
            raise ValueError('Expected an HTTP(S) course URL')
        with urlopen(Request(args.url, headers={'User-Agent': 'HuiLibrary-Course/1.0'}), timeout=25) as response:
            if response.headers.get_content_type() not in ('text/html', 'application/xhtml+xml'):
                raise ValueError('Expected an HTML course page')
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('Page exceeds 2 MB; inspect it with a browser instead')
            evidence = Evidence(response.url)
            evidence.feed(raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace'))
            text = '\n'.join(line.strip() for line in ''.join(evidence.text).splitlines() if line.strip())
            print(json.dumps({'url': response.url, 'checked_at': datetime.date.today().isoformat(), 'title': ''.join(evidence.title).strip(), 'text': text, 'links': evidence.links}, ensure_ascii=False, indent=2))
        return
    root = repo_root(); reader = library(root)
    if args.command == 'validate':
        metadata, _ = reader.parse_course(args.path.read_text(encoding='utf-8'))
        print(f"Valid course/v1: {metadata['id']} — {args.path}")
        return
    metadata = json.loads(args.spec.read_text(encoding='utf-8'))
    body = args.body.read_text(encoding='utf-8').strip()
    text = '---\n' + json.dumps(metadata, ensure_ascii=False, indent=2) + '\n---\n\n' + body + '\n'
    reader.parse_course(text)  # Validate before constructing paths or writing anything.
    if Path(args.topic).name != args.topic or args.topic.startswith('.'):
        raise ValueError('Topic must be a single non-hidden directory name')
    destination = root / 'books/07_课程' / args.topic / (metadata['id'] + '.md')
    for path in (root / 'books/07_课程').rglob('*.md'):
        previous, previous_body = reader.parse_course(path.read_text(encoding='utf-8'))
        same_url = canonical(previous['source_url']) == canonical(metadata['source_url'])
        same_edition = (previous['year'], previous['term']) == (metadata['year'], metadata['term'])
        if ((same_url and same_edition) or previous['id'] == metadata['id']) and path != destination:
            raise ValueError(f'Course already exists at {path}; preserve its path/id when updating')
        if path == destination:
            if not args.update:
                raise ValueError(f'Already exists: {path}; use --update for an intentional update')
            if not same_url or not same_edition:
                raise ValueError('Course source URL or edition changed; verify identity or create an independent edition')
            notes = re.search(r'^## 学习记录[ \t]*\n(.*?)(?=^## |\Z)', previous_body, re.M | re.S)
            if notes:
                text = re.sub(r'^## 学习记录[ \t]*\n.*?(?=^## |\Z)', '', text, flags=re.M | re.S).rstrip()
                text += '\n\n## 学习记录\n\n' + notes.group(1).strip() + '\n'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding='utf-8')
    print(destination.relative_to(root))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(f'course: {error}', file=sys.stderr)
        sys.exit(1)
