from refora_server.services.agent_intent import SYSTEM_PROMPT, _turn_messages


def test_system_prompt_restores_academic_web_frontier_report_and_memory_boundaries():
    assert "untrusted evidence" in SYSTEM_PROMPT
    assert "globally latest" in SYSTEM_PROMPT
    assert "Markdown links for external sources" in SYSTEM_PROMPT
    assert "/research.md limited to durable research summaries" in SYSTEM_PROMPT


def test_checkpoint_continuation_sends_only_the_new_user_message():
    history = [
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
    ]

    assert _turn_messages(history, "new question", "checkpoint-1") == [
        {"role": "user", "content": "new question"}
    ]
    assert _turn_messages(history, "new question", None) == [
        *history,
        {"role": "user", "content": "new question"},
    ]
