import pytest

from refora_server.db.errors import RepoError
from refora_server.server.services.result import error_response


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (RepoError("not_found", "missing"), 404, "not_found"),
        (RepoError("file_missing", "missing"), 404, "not_found"),
        (RepoError("duplicate", "exists"), 409, "conflict"),
        (RepoError("not_ready", "starting"), 503, "unavailable"),
        (RepoError("connector_timeout", "timed out"), 503, "unavailable"),
        (RepoError("invalid_input", "invalid"), 400, "invalid_input"),
        (ValueError("invalid"), 400, "validation"),
    ],
)
def test_result_error_mapping_is_canonical(error, status, code) -> None:
    response = error_response(error)

    assert response.status_code == status
    assert response.body == (
        f'{{"ok":false,"error":{{"code":"{code}","message":"{error}"}}}}'
    ).encode()
