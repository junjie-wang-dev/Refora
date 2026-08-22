from __future__ import annotations

import ipaddress
import re
from typing import Any
from urllib.parse import urlsplit


class ProxyValidationError(ValueError):
    code = "invalid_proxy"


def is_valid_proxy_url(url: str) -> bool:
    if not url:
        return True
    if any(character.isspace() for character in url):
        return False
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https", "socks5"}:
            return False
        hostname = parsed.hostname
        if not hostname or parsed.username is not None or parsed.password is not None:
            return False
        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            try:
                ascii_hostname = hostname.encode("idna").decode("ascii").rstrip(".")
            except UnicodeError:
                return False
            labels = ascii_hostname.split(".")
            if (
                not ascii_hostname
                or len(ascii_hostname) > 253
                or all(character in "0123456789." for character in ascii_hostname)
                or any(
                    not re.fullmatch(
                        r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?",
                        label,
                    )
                    for label in labels
                )
            ):
                return False
        if parsed.path or parsed.query or parsed.fragment:
            return False
        if parsed.netloc.endswith(":"):
            return False
        port = parsed.port
        return port is None or 1 <= port <= 65535
    except (TypeError, ValueError):
        return False


def normalize_proxy_rules(value: Any) -> str:
    if not isinstance(value, str):
        raise ProxyValidationError("proxyUrl must be a string")
    rules = value.strip()
    if not is_valid_proxy_url(rules):
        raise ProxyValidationError(
            "proxyUrl must be empty or a valid http, https, or socks5 proxy URL "
            "without credentials, path, query, or fragment"
        )
    return rules
