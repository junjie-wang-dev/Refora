from __future__ import annotations

import asyncio
import inspect
import json
import time
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from typing import Any


_SECRET_KEYS = {"apiKey", "api_key", "authorization", "Authorization"}
_TERMINAL_STATUSES = {"completed", "failed", "cancelled", "interrupted"}


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _truncate(value: Any, limit: int = 4000) -> str | None:
    if value is None:
        return None
    text = _as_text(value)
    return text if len(text) <= limit else text[:limit]


def _without_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[redacted]" if key in _SECRET_KEYS else _without_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_without_secrets(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_without_secrets(item) for item in value)
    return value


def _checkpoint_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    direct = value.get("checkpointId") or value.get("checkpoint_id")
    if isinstance(direct, str) and direct:
        return direct
    config = value.get("config")
    if isinstance(config, dict):
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            checkpoint = configurable.get("checkpoint_id") or configurable.get("checkpointId")
            if isinstance(checkpoint, str) and checkpoint:
                return checkpoint
    return None


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_message_text(part.get("text") if isinstance(part, dict) else part) for part in value)
    if isinstance(value, dict):
        return _message_text(value.get("text") or value.get("content"))
    return ""


def _result_text(result: Any) -> str:
    if isinstance(result, dict):
        messages = result.get("messages")
        if isinstance(messages, list) and messages:
            return _message_text(messages[-1].get("content") if isinstance(messages[-1], dict) else messages[-1])
        for key in ("content", "text", "output"):
            if key in result:
                return _message_text(result[key])
    return _message_text(result)


def _tool_message_texts(result: Any, state: dict[str, Any]) -> list[str]:
    sources = [result]
    values = state.get("values") if isinstance(state, dict) else None
    if isinstance(values, dict):
        sources.append(values)
    texts: list[str] = []
    for source in sources:
        messages = source.get("messages") if isinstance(source, dict) else None
        if not isinstance(messages, list):
            continue
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role") or message.get("type")
            if role not in {"tool", "ToolMessage"}:
                continue
            text = _message_text(message.get("content"))
            if text and text not in texts:
                texts.append(text)
    return texts


def _interrupt_actions(state: Any) -> list[dict[str, Any]]:
    if not isinstance(state, dict):
        return []
    actions: list[dict[str, Any]] = []
    for task in state.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        for interrupt in task.get("interrupts") or []:
            value = interrupt.get("value") if isinstance(interrupt, dict) else None
            if not isinstance(value, dict):
                continue
            requests = value.get("actionRequests") or value.get("action_requests") or []
            configs = value.get("reviewConfigs") or value.get("review_configs") or []
            for index, request in enumerate(requests):
                if not isinstance(request, dict) or not isinstance(request.get("name"), str):
                    continue
                config = configs[index] if index < len(configs) and isinstance(configs[index], dict) else {}
                allowed = config.get("allowedDecisions") or config.get("allowed_decisions")
                decisions = [value for value in allowed if value in {"approve", "edit", "reject"}] if isinstance(allowed, list) else ["approve", "reject"]
                action = {
                    "name": request["name"],
                    "args": request.get("args") if isinstance(request.get("args"), dict) else {},
                    "allowedDecisions": decisions,
                }
                if isinstance(request.get("description"), str):
                    action["description"] = request["description"]
                actions.append(action)
    return actions


def _event_delta(event: dict[str, Any], reasoning: bool) -> str:
    keys = ("reasoning", "reasoning_content", "thinking", "delta") if reasoning else ("delta", "token", "content", "text")
    for key in keys:
        value = event.get(key)
        if isinstance(value, str):
            return value
    data = event.get("data")
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, str):
                return value
        chunk = data.get("chunk") or data.get("output")
        if isinstance(chunk, dict):
            additional = chunk.get("additional_kwargs")
            if reasoning and isinstance(additional, dict):
                value = additional.get("reasoning_content")
                if isinstance(value, str):
                    return value
            return _message_text(chunk.get("content"))
    return ""


def createAgentRuntime(repos: dict[str, Any], deps: dict[str, Any] | None = None):
    deps = deps or {}
    active: dict[str, dict[str, Any]] = {}
    clock: Callable[[], int] = deps.get("clock") or _now_ms
    create_tools = deps.get("createTools") or deps.get("create_tools")
    create_model = deps.get("createModel") or deps.get("create_model")
    create_agent = deps.get("createAgent") or deps.get("create_agent")
    stream_factory = deps.get("stream")
    emit = deps.get("emit")
    logger = deps.get("logger")

    async def emit_event(name: str, payload: dict[str, Any]) -> None:
        safe_payload = _without_secrets(payload)
        try:
            if emit is not None:
                await _await(emit(name, safe_payload))
            callback = deps.get("on" + "".join(part.title() for part in name.split(".")))
            if callback is not None:
                await _await(callback(safe_payload))
        except Exception:
            return

    def warn(message: str) -> None:
        if logger is not None:
            try:
                logger.warning(message)
            except Exception:
                return

    async def emit_status(run_id: str, status: str) -> None:
        protocol_status = "running" if status == "running" else "waiting" if status == "interrupted" else "idle"
        await emit_event("ai.chat.run-status", {"runId": run_id, "status": protocol_status})

    async def emit_trace(request: dict[str, Any], event: dict[str, Any]) -> None:
        await emit_event(
            "ai.chat.trace",
            {
                "runId": request["runId"],
                "name": event.get("name") if isinstance(event.get("name"), str) else "agent",
                "parentIds": [value for value in event.get("parent_ids", event.get("parentIds", [])) if isinstance(value, str)],
                "data": _without_secrets(event.get("data") if isinstance(event.get("data"), dict) else {}),
                "tags": [value for value in event.get("tags", []) if isinstance(value, str)],
                "metadata": _without_secrets(event.get("metadata") if isinstance(event.get("metadata"), dict) else {}),
            },
        )

    def add_trace(request: dict[str, Any], seq: int, kind: str, name: str | None, status: str, data: Any = None, checkpoint: str | None = None) -> dict[str, Any]:
        return repos["agentTraces"]["addStep"](
            {
                "threadId": request["threadId"],
                "runId": request["runId"],
                "kind": kind,
                "name": name,
                "input": None,
                "output": _truncate(_without_secrets(data)),
                "status": status,
                "startedAt": clock(),
                "endedAt": clock() if status != "running" else None,
                "seq": seq,
                "checkpointId": checkpoint,
            }
        )

    def close_open_traces(run_id: str, status: str, message: str) -> None:
        for step in repos["agentTraces"]["listByRun"](run_id):
            if step.get("status") == "running":
                repos["agentTraces"]["updateStep"](
                    step["id"], {"status": status, "output": _truncate(message), "endedAt": clock()}
                )

    async def create_runtime_agent(request: dict[str, Any]) -> Any:
        if create_tools is None:
            raise RuntimeError("createTools dependency is not configured")
        tools = await _await(create_tools(request))
        provider = dict(request.get("provider") or {})
        model = await _await(create_model(provider)) if create_model is not None else None
        if create_agent is None:
            raise RuntimeError("createAgent dependency is not configured")
        return await _await(create_agent(model, tools, request))

    async def event_stream(agent: Any, request: dict[str, Any], mode: str) -> AsyncIterable[Any]:
        if stream_factory is not None:
            return await _await(stream_factory(agent, request, mode))
        if hasattr(agent, "astream_events"):
            invocation: Any = {"messages": request.get("messages") or []}
            if mode == "resume":
                invocation = {"resume": {"decisions": request.get("decisions") or []}}
            config = {
                "configurable": {"thread_id": request["threadId"]},
                "recursion_limit": int(request.get("recursionLimit") or 50),
            }
            if request.get("checkpointBefore"):
                config["configurable"]["checkpoint_id"] = request["checkpointBefore"]
            return agent.astream_events(invocation, config=config, version="v2")
        if hasattr(agent, "stream"):
            return await _await(agent.stream(request, mode))
        raise RuntimeError("Agent does not provide a stream")

    async def finish_interrupted(request: dict[str, Any], state: dict[str, Any], run_trace: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        checkpoint = _checkpoint_id(state) or request.get("checkpointBefore")
        actions = _interrupt_actions(state)
        repos["chat"]["updateAgentState"](request["threadId"], checkpoint, int(deps.get("agentStateVersion", 1)))
        repos["agentRuns"]["update"](
            run_id,
            {"status": "interrupted", "checkpointAfter": checkpoint, "endedAt": clock()},
        )
        interrupt = repos["agentInterrupts"]["create"](
            {"runId": run_id, "threadId": request["threadId"], "checkpointId": checkpoint, "actions": actions}
        )
        repos["agentTraces"]["updateStep"](
            run_trace["id"], {"status": "completed", "output": "Interrupted", "endedAt": clock()}
        )
        await emit_event("ai.chat.interrupted", {"runId": run_id, "threadId": request["threadId"]})
        await emit_status(run_id, "interrupted")
        return {"runId": run_id, "status": "interrupted", "interrupt": interrupt, "state": state}

    async def finish_completed(request: dict[str, Any], result: Any, state: dict[str, Any], run_trace: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        text = _result_text(result)
        for tool_text in _tool_message_texts(result, state):
            repos["chat"]["addMessage"](request["threadId"], "tool", tool_text)
        message = repos["chat"]["addMessage"](request["threadId"], "assistant", text)
        checkpoint = _checkpoint_id(state) or request.get("checkpointBefore")
        repos["chat"]["updateAgentState"](request["threadId"], checkpoint, int(deps.get("agentStateVersion", 1)))
        run = repos["agentRuns"]["update"](
            run_id,
            {
                "status": "completed",
                "checkpointAfter": checkpoint,
                "assistantMessageId": message["id"],
                "endedAt": clock(),
            },
        )
        repos["agentTraces"]["updateStep"](
            run_trace["id"], {"status": "completed", "output": _truncate(text), "endedAt": clock()}
        )
        title = None
        title_source = deps.get("generateTitle") or deps.get("generate_title")
        thread = repos["chat"]["getThread"](request["threadId"])
        if title_source is not None and thread and not thread.get("title"):
            candidate = await _await(title_source(request["threadId"], dict(request.get("provider") or {})))
            if isinstance(candidate, str) and candidate.strip():
                title = candidate.strip()[:100]
                repos["chat"]["updateTitle"](request["threadId"], title)
                await emit_event("ai.chat.title-updated", {"threadId": request["threadId"], "title": title})
        await emit_event("ai.chat.done", {"runId": run_id, "threadId": request["threadId"], "result": _without_secrets(result), "state": _without_secrets(state)})
        await emit_status(run_id, "completed")
        return {"runId": run_id, "status": "completed", "run": run, "result": result, "state": state, "title": title}

    async def terminalize(request: dict[str, Any], status: str, error: str, run_trace: dict[str, Any] | None) -> dict[str, Any]:
        run_id = request["runId"]
        close_open_traces(run_id, "cancelled" if status == "cancelled" else "error", error)
        run = repos["agentRuns"]["update"](run_id, {"status": status, "endedAt": clock(), "error": error})
        if run_trace is not None:
            repos["agentTraces"]["updateStep"](
                run_trace["id"], {"status": "cancelled" if status == "cancelled" else "error", "output": _truncate(error), "endedAt": clock()}
            )
        if status == "failed":
            await emit_event("ai.chat.error", {"runId": run_id, "threadId": request["threadId"], "error": {"code": "agent_failed", "message": error}})
        await emit_status(run_id, status)
        return {"runId": run_id, "status": status, "run": run, "error": error}

    async def run(request: dict[str, Any], mode: str = "send", existing_run: bool = False) -> dict[str, Any]:
        request = dict(request)
        run_id = request.get("runId")
        thread_id = request.get("threadId")
        if not isinstance(run_id, str) or not run_id or not isinstance(thread_id, str) or not thread_id:
            return {"runId": run_id, "status": "failed", "error": "runId and threadId are required"}
        thread = repos["chat"]["getThread"](thread_id)
        if thread is None:
            return {"runId": run_id, "status": "failed", "error": "Thread not found"}
        provider = request.get("provider") if isinstance(request.get("provider"), dict) else {}
        model = provider.get("model") if isinstance(provider.get("model"), str) else ""
        control = {"cancelled": False, "agent": None}
        active[run_id] = control
        user_message = None
        run_trace: dict[str, Any] | None = None
        try:
            if not existing_run:
                for message in reversed(request.get("messages") or []):
                    if isinstance(message, dict) and message.get("role") in {"user", "human"}:
                        content = _message_text(message.get("content"))
                        if content:
                            user_message = repos["chat"]["addMessage"](thread_id, "user", content)
                        break
                repos["agentRuns"]["create"](
                    {
                        "id": run_id,
                        "threadId": thread_id,
                        "providerId": thread["providerId"],
                        "modelId": model,
                        "status": "queued",
                        "checkpointBefore": request.get("checkpointBefore"),
                        "userMessageId": user_message["id"] if user_message else None,
                        "startedAt": clock(),
                    }
                )
                await emit_status(run_id, "queued")
            repos["agentRuns"]["update"](run_id, {"status": "running", "endedAt": None, "error": None})
            await emit_status(run_id, "running")
            run_trace = add_trace(request, 0, "run", "agent", "running", checkpoint=request.get("checkpointBefore"))
            agent = await create_runtime_agent(request)
            control["agent"] = agent
            stream = await event_stream(agent, request, mode)
            if not isinstance(stream, AsyncIterable):
                if not isinstance(stream, Iterable):
                    raise RuntimeError("Agent stream is not iterable")
                events: AsyncIterable[Any] = _iterate(stream)
            else:
                events = stream
            seq = 1
            result: Any = None
            state: dict[str, Any] = {}
            interrupted = False
            async for raw in events:
                if control["cancelled"]:
                    return await terminalize(request, "cancelled", "Cancelled", run_trace)
                event = raw if isinstance(raw, dict) else {"event": "trace", "data": raw}
                event_name = str(event.get("event") or event.get("type") or "")
                if event_name in {"token", "on_chat_model_stream"}:
                    delta = _event_delta(event, False)
                    if delta:
                        await emit_event("ai.chat.token", {"runId": run_id, "threadId": thread_id, "delta": delta})
                    continue
                if event_name in {"reasoning", "thinking"}:
                    delta = _event_delta(event, True)
                    if delta:
                        await emit_event("ai.chat.reasoning", {"runId": run_id, "threadId": thread_id, "delta": delta})
                    continue
                if event_name in {"done", "complete", "result"}:
                    result = event.get("result", event.get("data"))
                    candidate_state = event.get("state")
                    if isinstance(candidate_state, dict):
                        state = candidate_state
                    continue
                if event_name in {"error", "on_chain_error", "on_tool_error"}:
                    detail = event.get("error") or event.get("data") or "Agent execution failed"
                    raise RuntimeError(_as_text(detail))
                if event_name in {"interrupted", "interrupt"}:
                    candidate_state = event.get("state") or event.get("data")
                    state = candidate_state if isinstance(candidate_state, dict) else state
                    interrupted = True
                    continue
                if event_name in {"title-updated", "title_updated"}:
                    data = event.get("data")
                    title = event.get("title")
                    if not isinstance(title, str) and isinstance(data, dict):
                        title = data.get("title")
                    if isinstance(title, str) and title.strip():
                        repos["chat"]["updateTitle"](thread_id, title.strip()[:100])
                        await emit_event("ai.chat.title-updated", {"threadId": thread_id, "title": title.strip()[:100]})
                    continue
                await emit_trace(request, event)
                checkpoint = _checkpoint_id(event)
                add_trace(request, seq, "tool" if "tool" in event_name else "model", event.get("name") if isinstance(event.get("name"), str) else event_name or "agent", "completed", event.get("data"), checkpoint)
                seq += 1
            if control["cancelled"]:
                return await terminalize(request, "cancelled", "Cancelled", run_trace)
            if interrupted or _interrupt_actions(state):
                return await finish_interrupted(request, state, run_trace)
            return await finish_completed(request, result, state, run_trace)
        except asyncio.CancelledError:
            return await terminalize(request, "cancelled", "Cancelled", run_trace)
        except Exception as error:
            message = _as_text(error)
            api_key = provider.get("apiKey") if isinstance(provider, dict) else None
            if isinstance(api_key, str) and api_key:
                message = message.replace(api_key, "[redacted]")
            warn(f"agent runtime failed run={run_id}")
            return await terminalize(request, "cancelled" if control["cancelled"] else "failed", message or "Agent execution failed", run_trace)
        finally:
            active.pop(run_id, None)

    async def send(request: dict[str, Any]) -> dict[str, Any]:
        return await run(request, "send")

    async def resume(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request.get("runId")
        if not isinstance(run_id, str) or not run_id:
            return {"runId": run_id, "status": "failed", "error": "runId is required"}
        persisted = repos["agentRuns"]["get"](run_id)
        interrupt = repos["agentInterrupts"]["getPendingByRun"](run_id)
        if persisted is None or interrupt is None:
            return {"runId": run_id, "status": "failed", "error": "No pending interrupt for run"}
        decisions = request.get("decisions")
        if not isinstance(decisions, list) or len(decisions) != len(interrupt["actions"]):
            return {"runId": run_id, "status": "failed", "error": "Interrupt decisions do not match pending actions"}
        for decision, action in zip(decisions, interrupt["actions"]):
            decision_type = decision.get("type") if isinstance(decision, dict) else None
            if decision_type not in action.get("allowedDecisions", []):
                return {"runId": run_id, "status": "failed", "error": "Interrupt decision is not allowed"}
        repos["agentInterrupts"]["resolve"](interrupt["id"], decisions)
        request = {**request, "threadId": persisted["threadId"], "checkpointBefore": interrupt.get("checkpointId") or persisted.get("checkpointAfter")}
        return await run(request, "resume", existing_run=True)

    async def cancel(run_id: str) -> dict[str, Any]:
        control = active.get(run_id)
        if control is None:
            run = repos["agentRuns"]["get"](run_id)
            if run is None or run.get("status") in _TERMINAL_STATUSES:
                return {"runId": run_id, "cancelled": False}
            request = {"runId": run_id, "threadId": run["threadId"]}
            await terminalize(request, "cancelled", "Cancelled", None)
            return {"runId": run_id, "cancelled": True}
        control["cancelled"] = True
        agent = control.get("agent")
        for method_name in ("cancel", "abort", "aclose"):
            method = getattr(agent, method_name, None)
            if callable(method):
                try:
                    await _await(method())
                except Exception:
                    pass
                break
        return {"runId": run_id, "cancelled": True}

    def destroy() -> None:
        for control in active.values():
            control["cancelled"] = True

    return {"send": send, "run": run, "resume": resume, "cancel": cancel, "destroy": destroy}


async def _iterate(values: Iterable[Any]):
    for value in values:
        yield value
