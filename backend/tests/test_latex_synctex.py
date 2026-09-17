from __future__ import annotations

import gzip
from refora_server.services.latex_synctex import read_synctex


def write_map(tmp_path, body, inputs=None, unit=1, magnification=1000):
    output = tmp_path / 'main.synctex.gz'
    inputs = inputs or f'Input:1:{tmp_path}/main.tex\nInput:2:{tmp_path}/parts/second.tex\nInput:3:/outside/private.tex'
    data = f'SyncTeX Version:1\n{inputs}\nOutput:pdf\nMagnification:{magnification}\nUnit:{unit}\nX Offset:0\nY Offset:0\nContent:\n{body}\nPostamble:\nCount:10\n'
    output.write_bytes(gzip.compress(data.encode()))
    return output


def test_synctex_maps_multiple_pages_files_and_pdf_points(tmp_path):
    output = write_map(tmp_path, '{1\n(1,4:6578176,13156352:6578176,657818,0\nx1,4:9867264,13156352\n)\n}1\n{2\n(2,9:6578176,13156352:6578176,657818,0\nx2,9:9867264,13156352\n)\n}2')
    hashes = {'main.tex': 'first', 'parts/second.tex': 'second'}
    result = read_synctex(output, tmp_path, tmp_path, hashes)
    assert result['sourceHashes'] == hashes
    first, second = result['boxes']
    assert (first['path'], first['line'], first['page']) == ('main.tex', 4, 1)
    assert (second['path'], second['line'], second['page']) == ('parts/second.tex', 9, 2)
    assert abs(first['x'] - 100) < 0.001
    assert abs(first['y'] - 190) < 0.001
    assert abs(first['width'] - 50) < 0.001
    assert abs(first['height'] - 10) < 0.001


def test_synctex_only_exposes_compiled_project_sources(tmp_path):
    output = write_map(tmp_path, '{1\nh3,1:10,20:30,40,0\nh1,8:6578176,13156352:6578176,657818,0\n}1')
    result = read_synctex(output, tmp_path, tmp_path, {'main.tex': 'hash'})
    assert len(result['boxes']) == 1
    assert result['boxes'][0]['path'] == 'main.tex'
    assert '/outside' not in str(result)


def test_nested_root_relative_paths_and_repeated_vertical_position(tmp_path):
    (tmp_path / 'paper').mkdir()
    output = write_map(tmp_path, '{1\n(1,7:100,200:300,100,0\nx1,7:200,=\nx1,7:300,=\n)\n}1', inputs='Input:1:./main.tex', unit=8192, magnification=1200)
    result = read_synctex(output, tmp_path, tmp_path / 'paper', {'paper/main.tex': 'hash'})
    assert result['boxes'][0]['path'] == 'paper/main.tex'
    assert result['boxes'][0]['width'] > 20


def test_missing_invalid_and_symlink_maps_do_not_break_pdf_preview(tmp_path):
    output = tmp_path / 'main.synctex.gz'
    assert read_synctex(output, tmp_path, tmp_path, {}) is None
    output.write_bytes(b'invalid')
    assert read_synctex(output, tmp_path, tmp_path, {}) is None
    output.unlink()
    output.symlink_to(tmp_path / 'missing')
    assert read_synctex(output, tmp_path, tmp_path, {}) is None


def test_oversized_decompressed_lines_are_rejected(tmp_path):
    output = tmp_path / 'large.synctex.gz'
    output.write_bytes(gzip.compress(b'x' * 100000))
    assert read_synctex(output, tmp_path, tmp_path, {}) is None
