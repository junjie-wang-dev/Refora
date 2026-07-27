from __future__ import annotations

import os

from refora_server.services.agent_sandbox import AgentSandbox


def test_sandbox_confines_text_operations_to_root(tmp_path):
    sandbox = AgentSandbox(tmp_path / "sandbox")

    assert sandbox.write("outputs/result.txt", "hello").get("error") is None
    assert sandbox.read("/outputs/result.txt")["content"] == "1: hello"
    assert sandbox.write("../outside.txt", "no")["error"]
    assert not (tmp_path / "outside.txt").exists()


def test_sandbox_rejects_symlink_escape_and_arbitrary_execution(tmp_path):
    sandbox = AgentSandbox(tmp_path / "sandbox")
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, tmp_path / "sandbox" / "escape")

    assert sandbox.write("escape/no.txt", "no")["error"]
    assert sandbox.execute("rm -rf /")["exit_code"] == 126


def test_sandbox_upload_download_and_edit_are_bounded(tmp_path):
    sandbox = AgentSandbox(tmp_path / "sandbox")

    assert sandbox.upload_files([("work/a.txt", b"before")])[0]["error"] is None
    assert sandbox.edit("work/a.txt", "before", "after").get("error") is None
    assert sandbox.download_files(["work/a.txt"])[0]["content"] == b"after"
