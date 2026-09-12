from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import time
from pathlib import Path

from refora_server.services.latex import LatexService

CORPUS = [
    ('arxiv-1706.03762.tar.gz', 'Attention Is All You Need', 'https://arxiv.org/src/1706.03762', 'ms.tex'),
    ('arxiv-1810.04805.tar.gz', 'BERT', 'https://arxiv.org/src/1810.04805', 'main.tex'),
    ('arxiv-2005.14165.tar.gz', 'Language Models are Few-Shot Learners', 'https://arxiv.org/src/2005.14165', 'main.tex'),
    ('IEEEtran.zip', 'IEEE journal', 'https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip', 'IEEEtran/bare_jrnl.tex'),
    ('elsarticle.zip', 'Elsevier article', 'https://mirrors.ctan.org/macros/latex/contrib/elsarticle.zip', 'elsarticle/elsarticle-template-num.tex'),
    ('revtex.zip', 'APS REVTeX', 'https://mirrors.ctan.org/macros/latex/contrib/revtex.zip', 'revtex/sample/aps/apssamp.tex'),
]


def main():
    parser = argparse.ArgumentParser(description='Import and compile real LaTeX source archives through Refora')
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tex-bin', type=Path)
    args = parser.parse_args()
    destination = args.output.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    settings = {'latexBinPath': str(args.tex_bin.resolve()) if args.tex_bin else ''}
    service = LatexService(lambda _: str(destination / 'sandbox'), lambda _: None, lambda _: None, settings)
    results = []
    for filename, title, url, root in CORPUS:
        started = time.monotonic()
        row = {'archive': filename, 'title': title, 'url': url, 'root': root, 'success': False}
        try:
            archive = args.sources.resolve() / filename
            digest = hashlib.sha256()
            with archive.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            row['sourceSha256'] = digest.hexdigest()
            project = service.operate('validation', {'action': 'import', 'importPath': str(archive)})['project']
            row['files'] = len(project['files'])
            service.operate('validation', {'action': 'root', 'projectId': project['id'], 'path': root})
            result = service.operate('validation', {'action': 'compile', 'projectId': project['id'], 'engine': 'pdflatex'})['compilation']
            row['success'] = result['success']
            (destination / (filename + '.log')).write_text(result['log'])
            pages = re.findall(r'Output written on .*?\((\d+) pages?', result['log'])
            row['pages'] = int(pages[-1]) if pages else None
            row['warnings'] = [line for line in result['log'].splitlines() if 'Warning' in line or 'not found' in line or 'Error' in line][-30:]
            if result.get('pdfBase64'):
                (destination / (filename + '.pdf')).write_bytes(base64.b64decode(result['pdfBase64']))
        except Exception as error:
            row['error'] = str(error)
        row['seconds'] = round(time.monotonic() - started, 2)
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
        (destination / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    return 0 if all(row['success'] for row in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
