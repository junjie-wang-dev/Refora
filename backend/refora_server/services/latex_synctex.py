from __future__ import annotations

import gzip
import math
import os
import re
import zlib
from pathlib import Path


def read_synctex(output: Path, build: Path, cwd: Path, sources: dict[str, str]) -> dict | None:
    inputs: dict[int, str] = {}
    boxes: dict[tuple, dict] = {}
    stack: list[dict] = []
    page = 0
    previous_y = 0
    unit = 1.0
    magnification = 1000.0
    offset_x = offset_y = 0.0
    total = 0
    complete = False
    record = re.compile(r'^([\[(hvkgrx$])\s*(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+|=)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$')

    def add(path, line, x, y, width, height):
        if not path or line < 1 or page < 1 or height <= 0:
            return
        scale = unit * magnification / 1000 / 65781.76
        values = [(x + offset_x) * scale, (y + offset_y) * scale, max(1, abs(width) * scale), max(2, height * scale)]
        if not all(math.isfinite(value) and abs(value) < 100000 for value in values):
            return
        left, top, width, height = values
        key = (path, line, page, round(top, 1), round(height, 1))
        if key in boxes:
            box = boxes[key]
            right = max(box['x'] + box['width'], left + width)
            box['x'] = min(box['x'], left)
            box['width'] = right - box['x']
        else:
            boxes[key] = {'path': path, 'line': line, 'page': page, 'x': left, 'y': top, 'width': width, 'height': height}

    try:
        if output.is_symlink() or not output.is_file() or output.stat().st_size > 32 * 1024 * 1024:
            return None
        fd = os.open(output, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as raw, gzip.GzipFile(fileobj=raw) as stream:
            while line_bytes := stream.readline(65537):
                total += len(line_bytes)
                if len(line_bytes) > 65536 or total > 32 * 1024 * 1024 or len(boxes) > 100000 or len(stack) > 4096:
                    return None
                text = line_bytes.decode('utf-8', errors='replace').strip()
                if text.startswith('Input:'):
                    _, tag, name = text.split(':', 2)
                    candidate = (cwd / name).resolve()
                    if candidate.is_relative_to(build):
                        path = candidate.relative_to(build).as_posix()
                        if path in sources:
                            inputs[int(tag)] = path
                elif text.startswith('Unit:'):
                    unit = float(text.split(':', 1)[1])
                elif text.startswith('Magnification:'):
                    magnification = float(text.split(':', 1)[1])
                elif text.startswith('X Offset:'):
                    offset_x = float(text.split(':', 1)[1])
                elif text.startswith('Y Offset:'):
                    offset_y = float(text.split(':', 1)[1])
                elif text.startswith('{'):
                    page = int(text[1:])
                    stack.clear()
                elif text.startswith('}'):
                    page = 0
                    stack.clear()
                elif text in {')', ']'} and stack:
                    box = stack.pop()
                    if box['kind'] == '(' and not box['mapped']:
                        add(box['path'], box['line'], box['x'], box['y'] - box['height'], box['width'], box['height'] + box['depth'])
                elif match := record.fullmatch(text):
                    kind, tag, source_line, _, x, y, width, height, depth = match.groups()
                    x = int(x)
                    y = previous_y if y == '=' else int(y)
                    previous_y = y
                    width, height, depth = int(width or 0), int(height or 0), int(depth or 0)
                    path = inputs.get(int(tag))
                    source_line = int(source_line)
                    if kind in {'[', '('}:
                        stack.append({'kind': kind, 'path': path, 'line': source_line, 'x': x, 'y': y, 'width': width, 'height': height, 'depth': depth, 'last_x': x, 'mapped': False})
                    elif kind in {'h', 'v', 'r'}:
                        add(path, source_line, x, y - height, width, height + depth)
                    elif kind in {'x', '$'}:
                        parent = next((box for box in reversed(stack) if box['kind'] == '('), None)
                        if parent and path:
                            add(path, source_line, min(parent['last_x'], x), y - parent['height'], abs(x - parent['last_x']), parent['height'] + parent['depth'])
                            for box in stack:
                                box['mapped'] = True
                    if kind not in {'[', '('}:
                        for box in reversed(stack):
                            if box['kind'] == '(':
                                box['last_x'] = x
                                break
                elif text.startswith('Postamble:'):
                    complete = True
                    break
        return {'boxes': list(boxes.values()), 'sourceHashes': sources} if boxes and complete and unit > 0 and magnification > 0 else None
    except (OSError, EOFError, ValueError, OverflowError, zlib.error):
        return None
