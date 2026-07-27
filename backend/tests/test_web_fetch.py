from __future__ import annotations

from refora_server.services.web_fetch import htmlToMarkdown


def test_html_to_markdown_renders_table_as_gfm_pipes() -> None:
    html = """<html><body><article>
    <h1>Study</h1>
    <table>
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Acc</td><td>95%</td></tr>
        <tr><td>Acc|Err</td><td>x</td></tr>
      </tbody>
    </table>
    </article></body></html>"""
    text = htmlToMarkdown(html, "https://example.test/")["text"]
    assert "| Metric | Value |" in text
    assert "| --- | --- |" in text
    assert "| Acc | 95% |" in text
    assert "| Acc\\|Err | x |" in text


def test_html_to_markdown_renders_table_without_thead() -> None:
    html = """<article>
    <table>
      <tbody>
        <tr><th>Key</th><th>Val</th></tr>
        <tr><td>a</td><td>b</td></tr>
      </tbody>
    </table></article>"""
    text = htmlToMarkdown(html, "https://example.test/")["text"]
    assert "| Key | Val |" in text
    assert "| a | b |" in text


def test_html_to_markdown_renders_nested_unordered_list() -> None:
    html = """<article>
    <ul>
      <li>First <strong>bold</strong></li>
      <li>Nested
        <ul><li>sub a</li><li>sub b</li></ul>
      </li>
    </ul>
    </article>"""
    text = htmlToMarkdown(html, "https://example.test/")["text"]
    assert "- First **bold**" in text
    assert "- Nested" in text
    assert "  - sub a" in text
    assert "  - sub b" in text


def test_html_to_markdown_renders_nested_ordered_list() -> None:
    html = """<article>
    <ol>
      <li>One</li>
      <li>Two
        <ol><li>two.a</li><li>two.b</li></ol>
      </li>
    </ol>
    </article>"""
    text = htmlToMarkdown(html, "https://example.test/")["text"]
    assert "1. One" in text
    assert "2. Two" in text
    assert "   1. two.a" in text
    assert "   2. two.b" in text


def test_html_to_markdown_renders_horizontal_rule() -> None:
    html = "<article><p>Before</p><hr><p>After</p></article>"
    text = htmlToMarkdown(html, "https://example.test/")["text"]
    assert "\n---\n" in text


def test_html_to_markdown_keeps_title_and_links_absolute() -> None:
    html = """<html><head><title>Page</title></head><body><article>
    <p>See <a href="/papers">the source</a>.</p>
    </article></body></html>"""
    result = htmlToMarkdown(html, "https://example.test/")
    assert result["title"] == "Page"
    assert "[the source](https://example.test/papers)" in result["text"]


def test_html_to_markdown_strips_removable_tags() -> None:
    html = """<article>
    <p>Keep</p>
    <script>window.bad = true</script>
    <nav>Navigation</nav>
    <img src="image.png" alt="Ignored">
    </article>"""
    text = htmlToMarkdown(html, "https://example.test/")["text"]
    assert "Keep" in text
    assert "window.bad" not in text
    assert "Navigation" not in text
    assert "image.png" not in text