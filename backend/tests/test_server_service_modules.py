from refora_server.server.lifespan import (
    _download_mineru_file,
    _mineru_worker_path,
    _summary_prompt,
)
from refora_server.server.services.academic_runtime import create_academic_runtime
from refora_server.server.services.library_route_support import (
    list_column_state,
    markdown_file_name,
)
from refora_server.server.services.lifespan_support import (
    download_mineru_file,
    mineru_worker_path,
    summary_prompt,
)


def test_lifespan_keeps_compatibility_exports_for_extracted_services():
    assert _download_mineru_file is download_mineru_file
    assert _mineru_worker_path is mineru_worker_path
    assert _summary_prompt is summary_prompt


def test_academic_runtime_is_unavailable_without_document_repository():
    assert create_academic_runtime({}, "/tmp/library", lambda: "") == {
        "services": {}
    }


def test_library_route_support_normalizes_user_facing_state():
    assert markdown_file_name('A/B: Paper.md') == "A-B- Paper.md"
    assert list_column_state({"columns": [], "sort": {}}) is None
