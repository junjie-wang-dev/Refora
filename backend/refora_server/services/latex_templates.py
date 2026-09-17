from __future__ import annotations

import re
from pathlib import Path

from refora_server.repositories.errors import RepoError


def detect_template(source: Path, root_file: str) -> str | None:
    from refora_server.services.latex import read_source, safe_path

    pending = [root_file]
    visited = set()
    declarations = []
    remaining = 1024 * 1024
    while pending and len(visited) < 64 and remaining > 0:
        name = pending.pop(0)
        if name in visited:
            continue
        visited.add(name)
        try:
            path = safe_path(source, name)
            if not path.is_file() or path.stat().st_size > remaining:
                continue
            remaining -= path.stat().st_size
            content = re.sub(r'(?<!\\)%[^\n]*', '', read_source(source, name)['content'])
        except RepoError:
            continue
        for match in re.finditer(r'\\(documentclass|usepackage|RequirePackage|LoadClass)\s*(?:\[([^\]]*)\]\s*)?\{([^}]+)\}', content):
            for value in match[3].split(','):
                package = value.strip().split('/')[-1]
                declarations.append((package.lower(), (match[2] or '').lower()))
                extension = '.cls' if match[1] in {'documentclass', 'LoadClass'} else '.sty'
                for parent in {Path(name).parent, Path('.')}:
                    pending.append((parent / (value.strip() + extension)).as_posix())
        for match in re.finditer(r'\\(?:input|include)\s*\{([^}]+)\}', content):
            value = match[1] if Path(match[1]).suffix else match[1] + '.tex'
            for parent in {Path(name).parent, Path('.')}:
                pending.append((parent / value).as_posix())
    for package, _ in declarations:
        match = re.fullmatch(r'(neurips|nips|iclr|icml|aaai|cvpr|iccv|eccv|acl|emnlp|naacl)[_-]?(\d{4})?(?:_conference)?', package)
        if match:
            venue = {'neurips': 'NeurIPS', 'nips': 'NeurIPS'}.get(match[1], match[1].upper())
            return f'{venue} {match[2]}' if match[2] else venue
    for package, options in declarations:
        if package == 'ieeetran':
            return 'IEEE Conference' if 'conference' in [option.strip() for option in options.split(',')] else 'IEEE Journal'
        if package in {'elsarticle', 'cas-sc', 'cas-dc'}:
            return 'Elsevier'
        if package == 'acmart':
            return 'ACM'
        if package in {'revtex4', 'revtex4-1', 'revtex4-2'}:
            return 'AIP / REVTeX' if 'aip' in [option.strip() for option in options.split(',')] else 'APS / REVTeX'
        if package == 'llncs':
            return 'Springer LNCS'
        if package in {'sn-jnl', 'svjour3'}:
            return 'Springer Nature'
        if package == 'mnras':
            return 'MNRAS'
        if package == 'aa':
            return 'Astronomy & Astrophysics'
        if package == 'jmlr2e':
            return 'JMLR'
    return None
