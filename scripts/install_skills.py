#!/usr/bin/env python3
"""Install only this repository's skills into its own .codex/skills."""
import argparse
import json
import shutil
import tempfile
from pathlib import Path

OWNER = 'fanfeilong-library-skills'


def install(root):
    source = root / 'skills'
    destination = root / '.codex/skills'
    candidates = sorted(path for path in source.iterdir() if path.is_dir() and (path / 'SKILL.md').is_file())
    destination.mkdir(parents=True, exist_ok=True)
    # Check all collisions before changing any installed skill.
    for skill in candidates:
        target = destination / skill.name
        if target.is_symlink():
            raise ValueError(f'Refusing to replace a symlink: {target}')
        if target.exists():
            marker = target / '.installed-by.json'
            if not marker.is_file() or json.loads(marker.read_text()).get('package') != OWNER:
                raise ValueError(f'Existing skill is not owned by this installer: {target}')
    for skill in candidates:
        target = destination / skill.name
        with tempfile.TemporaryDirectory(prefix='.install-', dir=destination) as directory:
            temporary = Path(directory)
            staged = temporary / 'new'
            shutil.copytree(skill, staged, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            (staged / '.installed-by.json').write_text(json.dumps({'package': OWNER, 'skill': skill.name}) + '\n')
            previous = temporary / 'previous'
            if target.exists():
                target.rename(previous)
            try:
                staged.rename(target)
            except BaseException:
                if previous.exists():
                    previous.rename(target)
                raise
        print(f'Installed {skill.name} -> {target}')
    print(f'{len(candidates)} repository skill(s) installed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    install(args.root.resolve())
