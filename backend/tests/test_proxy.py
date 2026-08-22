import pytest

from refora_server.services.proxy import normalize_proxy_rules


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", ""),
        ("  http://proxy.example:8080  ", "http://proxy.example:8080"),
        ("https://127.0.0.1:443", "https://127.0.0.1:443"),
        ("socks5://[::1]:1080", "socks5://[::1]:1080"),
    ],
)
def test_normalize_proxy_rules_accepts_supported_urls(value, expected):
    assert normalize_proxy_rules(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        None,
        "ftp://proxy.example:21",
        "http://user:password@proxy.example:8080",
        "http://proxy.example:70000",
        "http://proxy.example/path",
        "http://invalid_host:8080",
    ],
)
def test_normalize_proxy_rules_rejects_invalid_values(value):
    with pytest.raises(ValueError) as error:
        normalize_proxy_rules(value)
    assert getattr(error.value, "code", None) == "invalid_proxy"
