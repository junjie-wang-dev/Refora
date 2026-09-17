from __future__ import annotations

import difflib
import hashlib
import json
import uuid

from refora_server.repositories.errors import RepoError


def review_path(source, name):
    from refora_server.services.latex import safe_path
    safe_path(source, name)
    return safe_path(source.parent, f'reviews/{hashlib.sha256(name.encode()).hexdigest()}.json')


def read_review(source, name):
    path = review_path(source, name)
    return json.loads(path.read_text()) if path.is_file() else None


def review_files(source):
    from refora_server.services.latex import safe_path
    folder = safe_path(source.parent, 'reviews')
    return sorted(json.loads(path.read_text())['path'] for path in folder.glob('*.json') if not path.is_symlink())


def with_review(source, name):
    from refora_server.services.latex import read_source, safe_path
    review = read_review(source, name)
    file = read_source(source, name) if safe_path(source, name).is_file() else {'path': name, 'content': '', 'hash': ''}
    if not file['hash'] and not review:
        return read_source(source, name)
    return {**file, **({'review': review} if review else {})}


def propose(source, name, content, current):
    from refora_server.services.latex import atomic_write
    if read_review(source, name):
        raise RepoError('review_pending', 'Review the pending AI changes before requesting another edit to this file.')
    before = current['content'].splitlines(keepends=True)
    after = content.splitlines(keepends=True)
    edits = [
        {'id': str(index), 'startLine': start, 'endLine': end, 'before': ''.join(before[start:end]), 'after': ''.join(after[new_start:new_end]), 'status': 'pending'}
        for index, (tag, start, end, new_start, new_end) in enumerate(difflib.SequenceMatcher(None, before, after).get_opcodes()) if tag != 'equal'
    ]
    if not edits:
        return current
    review = {'id': uuid.uuid4().hex, 'path': name, 'baseContent': current['content'], 'expectedHash': current['hash'], 'edits': edits}
    atomic_write(review_path(source, name), json.dumps(review).encode())
    return {**current, 'review': review}


def resolve(source, request):
    from refora_server.services.latex import atomic_write, read_source, safe_path
    name = request.get('path')
    review = read_review(source, name)
    current = read_source(source, name) if safe_path(source, name).is_file() else {'path': name, 'content': '', 'hash': ''}
    if not review or review['id'] != request.get('reviewId'):
        raise RepoError('conflict', 'This AI review is no longer available. Reload the file.')
    decision = request.get('decision')
    if decision not in {'accept', 'reject'}:
        raise RepoError('validation', 'Choose accept or reject')
    edit_id = request.get('editId')
    targets = [edit for edit in review['edits'] if edit['status'] == 'pending' and (edit_id is None or edit['id'] == edit_id)]
    if not targets:
        raise RepoError('conflict', 'This change has already been reviewed.')
    if current['hash'] != review['expectedHash']:
        if decision == 'reject' and edit_id is None:
            review_path(source, name).unlink()
            return current
        raise RepoError('conflict', 'The file changed externally. Reject all pending changes and request a new edit.')
    for edit in targets:
        edit['status'] = 'accepted' if decision == 'accept' else 'rejected'
    lines = review['baseContent'].splitlines(keepends=True)
    for edit in reversed(review['edits']):
        if edit['status'] == 'accepted':
            lines[edit['startLine']:edit['endLine']] = [edit['after']]
    content = ''.join(lines)
    if content != current['content']:
        atomic_write(safe_path(source, name), content.encode())
    file = read_source(source, name) if safe_path(source, name).is_file() else current
    if any(edit['status'] == 'pending' for edit in review['edits']):
        review['expectedHash'] = file['hash']
        atomic_write(review_path(source, name), json.dumps(review).encode())
        return {**file, 'review': review}
    review_path(source, name).unlink()
    return file
