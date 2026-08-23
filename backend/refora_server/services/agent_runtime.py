from __future__ import annotations

import asyncio
import inspect
import os
import sqlite3
import time
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from typing import Any

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from refora_server.agent.academic_artifacts import AcademicArtifactStore
from refora_server.agent.engine import RunStateMachine
from refora_server.agent.engine_schema import (
    RUN_STATUS_CANCELLED,
    RUN_STATUS_COMPLETED,
    RUN_STATUS_FAILED,
    RUN_STATUS_INTERRUPTED,
    RUN_STATUS_QUEUED,
    RUN_STATUS_RUNNING,
    TRACE_STATUS_CANCELLED,
    TRACE_STATUS_DONE,
    TRACE_STATUS_ERROR,
    TRACE_STATUS_INTERRUPTED,
    TRACE_STATUS_RUNNING,
    is_terminal_run,
)
from refora_server.services.agent_checkpoint import (
    ACADEMIC_PERSISTENCE_REDACTION,
    AcademicRedactingSerializer,
    _artifact_ids_in_checkpoint_database,
    _checkpoint_artifact_root,
    _is_academic_tool_name,
    _prune_academic_artifacts,
)
from refora_server.services.agent_events import (
    _as_text,
    _checkpoint_id,
    _chunk_reasoning_text,
    _event_delta,
    _event_key,
    _interrupt_actions,
    _message_text,
    _persist_tool_history,
    _result_text,
    _resume_decision,
    _segment_separator,
    _serializable,
    _state_snapshot,
    _streamed_tool_call_previews,
    _subagent_name,
    _token_usage,
    _tool_event_key,
    _tool_event_name,
    _tool_event_record,
    _tool_event_values,
    _tool_history_records,
    _tool_output_failed,
    _trace_context,
    _truncate,
    _without_secrets,
)
from refora_server.services.thread_title import derive_thread_title


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def createAgentRuntime(repos: dict[str, Any], deps: dict[str, Any] | None = None):
    deps = deps or {}
    configured_checkpoint_path = deps.get("checkpointPath") or deps.get("checkpoint_path")
    if isinstance(configured_checkpoint_path, str) and configured_checkpoint_path:
        try:
            _prune_academic_artifacts(configured_checkpoint_path)
        except OSError:
            pass
    active: dict[str, dict[str, Any]] = {}
    active_by_thread: dict[str, str] = {}
    background_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
    title_tasks: set[asyncio.Task[Any]] = set()
    resume_contexts: dict[str, dict[str, Any]] = {}
    clock: Callable[[], int] = deps.get("clock") or _now_ms
    create_tools = deps.get("createTools") or deps.get("create_tools")
    create_model = deps.get("createModel") or deps.get("create_model")
    create_agent = deps.get("createAgent") or deps.get("create_agent")
    stream_factory = deps.get("stream")
    emit = deps.get("emit")
    logger = deps.get("logger")
    cancel_run = deps.get("cancelRun") or deps.get("cancel_run")
    finish_run = deps.get("finishRun") or deps.get("finish_run")
    state_machine = RunStateMachine(repos["agentRuns"], repos["agentTraces"], clock)

    async def emit_event(name: str, payload: dict[str, Any]) -> None:
        safe_payload = _without_secrets(_serializable(payload))
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
        run = repos["agentRuns"]["get"](run_id)
        payload = {"runId": run_id, "status": status}
        if run is not None:
            payload["threadId"] = run["threadId"]
        await emit_event("ai.chat.run-status", payload)

    async def emit_trace(request: dict[str, Any], step: dict[str, Any]) -> None:
        await emit_event(
            "ai.chat.trace",
            {
                "threadId": request["threadId"],
                "runId": request["runId"],
                "step": _without_secrets(step),
            },
        )

    def add_trace(
        request: dict[str, Any],
        seq: int,
        kind: str,
        name: str | None,
        status: str,
        data: Any = None,
        checkpoint: str | None = None,
        input_data: Any = None,
        parent_step_id: str | None = None,
        agent_name: str | None = None,
        namespace: str | None = None,
        depth: int = 0,
    ) -> dict[str, Any]:
        safe_data = (
            ACADEMIC_PERSISTENCE_REDACTION
            if _is_academic_tool_name(name)
            else _without_secrets(data)
        )
        safe_input = (
            None
            if _is_academic_tool_name(name)
            else _without_secrets(input_data)
        )
        return repos["agentTraces"]["addStep"](
            {
                "threadId": request["threadId"],
                "runId": request["runId"],
                "kind": kind,
                "name": name,
                "input": _truncate(safe_input),
                "output": _truncate(safe_data),
                "status": status,
                "startedAt": clock(),
                "endedAt": clock() if status != TRACE_STATUS_RUNNING else None,
                "seq": seq,
                "parentStepId": parent_step_id,
                "agentName": agent_name,
                "namespace": namespace,
                "depth": depth,
                "checkpointId": checkpoint,
            }
        )

    async def close_open_traces(
        request: dict[str, Any], status: str, message: str
    ) -> None:
        run_id = request["runId"]
        for step in repos["agentTraces"]["listByRun"](run_id):
            if step.get("kind") != "run" and step.get("status") == TRACE_STATUS_RUNNING:
                updated = repos["agentTraces"]["updateStep"](
                    step["id"],
                    {
                        "status": status,
                        "output": step.get("output") or _truncate(message),
                        "endedAt": clock(),
                    },
                )
                if updated is not None:
                    await emit_trace(request, updated)

    async def create_runtime_agent(request: dict[str, Any]) -> Any:
        if create_tools is None:
            raise RuntimeError("createTools dependency is not configured")
        tools = await _await(create_tools(request))
        provider = dict(request.get("provider") or {})
        model = await _await(create_model(provider)) if create_model is not None else None
        if create_agent is None:
            raise RuntimeError("createAgent dependency is not configured")
        return await _await(create_agent(model, tools, request))

    def runtime_config(request: dict[str, Any]) -> dict[str, Any]:
        configurable = {"thread_id": request["threadId"]}
        checkpoint = request.get("checkpointBefore")
        if (
            request.get("recoverLatestCheckpoint") is not True
            and isinstance(checkpoint, str)
            and checkpoint
        ):
            configurable["checkpoint_id"] = checkpoint
        return {
            "configurable": configurable,
            "recursion_limit": int(request.get("recursionLimit") or 50),
        }

    async def configure_checkpoint(
        agent: Any, request: dict[str, Any]
    ) -> aiosqlite.Connection | None:
        checkpoint_path = request.get("checkpointPath")
        if not isinstance(checkpoint_path, str) or not checkpoint_path:
            return None
        if getattr(agent, "checkpointer", None) is not None:
            return None
        try:
            parent = os.path.dirname(os.path.abspath(checkpoint_path))
            os.makedirs(parent, mode=0o700, exist_ok=True)
            connection = await aiosqlite.connect(checkpoint_path)
            agent.checkpointer = AsyncSqliteSaver(
                connection,
                serde=AcademicRedactingSerializer(
                    AcademicArtifactStore(_checkpoint_artifact_root(checkpoint_path))
                ),
            )
            return connection
        except (AttributeError, OSError, aiosqlite.Error):
            return None

    async def agent_state(agent: Any, request: dict[str, Any]) -> dict[str, Any]:
        config = runtime_config(request)
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            configurable.pop("checkpoint_id", None)
        for method_name in ("aget_state", "get_state"):
            method = getattr(agent, method_name, None)
            if not callable(method):
                continue
            try:
                return _state_snapshot(await _await(method(config)))
            except Exception:
                continue
        return {}

    async def event_stream(agent: Any, request: dict[str, Any], mode: str) -> AsyncIterable[Any]:
        if stream_factory is not None:
            return await _await(stream_factory(agent, request, mode))
        if hasattr(agent, "astream_events"):
            invocation: Any = {"messages": request.get("messages") or []}
            if mode == "resume":
                invocation = Command(
                    resume={"decisions": request.get("decisions") or []}
                )
            elif mode == "recover":
                invocation = None
            return agent.astream_events(
                invocation, config=runtime_config(request), version="v2"
            )
        if hasattr(agent, "stream"):
            return await _await(agent.stream(request, mode))
        raise RuntimeError("Agent does not provide a stream")

    async def finish_interrupted(request: dict[str, Any], state: dict[str, Any], run_trace: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        checkpoint = _checkpoint_id(state) or request.get("checkpointBefore")
        actions = _interrupt_actions(state)
        trace_steps = repos["agentTraces"]["listByRun"](run_id)
        matched_actions: set[str] = set()
        for step in trace_steps:
            if (
                step.get("kind") not in {"tool", "todo"}
                or step.get("status") != TRACE_STATUS_RUNNING
            ):
                continue
            updated = repos["agentTraces"]["updateStep"](
                step["id"],
                {
                    "status": TRACE_STATUS_INTERRUPTED,
                    "output": "Awaiting user approval",
                    "endedAt": clock(),
                },
            )
            if updated is not None:
                if isinstance(updated.get("name"), str):
                    matched_actions.add(updated["name"])
                await emit_trace(request, updated)
        next_seq = max((int(step.get("seq") or 0) for step in trace_steps), default=0) + 1
        for action in actions:
            if action["name"] in matched_actions:
                continue
            step = add_trace(
                request,
                next_seq,
                "tool",
                action["name"],
                TRACE_STATUS_INTERRUPTED,
                "Awaiting user approval",
                checkpoint,
                action.get("args"),
            )
            await emit_trace(request, step)
            next_seq += 1
        repos["chat"]["updateAgentState"](request["threadId"], checkpoint, int(deps.get("agentStateVersion", 1)))
        state_machine.transition(
            run_id,
            RUN_STATUS_RUNNING,
            RUN_STATUS_INTERRUPTED,
            {"checkpointAfter": checkpoint, "endedAt": clock()},
            run_trace,
            trace_output="Interrupted",
        )
        interrupt = repos["agentInterrupts"]["create"](
            {"runId": run_id, "threadId": request["threadId"], "checkpointId": checkpoint, "actions": actions}
        )
        await emit_event(
            "ai.chat.interrupted",
            {
                "runId": run_id,
                "threadId": request["threadId"],
                "interrupt": interrupt,
            },
        )
        await emit_status(run_id, RUN_STATUS_INTERRUPTED)
        return {"runId": run_id, "status": RUN_STATUS_INTERRUPTED, "interrupt": interrupt, "state": state}

    async def finish_completed(
        request: dict[str, Any],
        result: Any,
        state: dict[str, Any],
        run_trace: dict[str, Any],
        tool_history: list[dict[str, str | None]],
        partial: str = "",
    ) -> dict[str, Any]:
        run_id = request["runId"]
        await close_open_traces(
            request,
            TRACE_STATUS_CANCELLED,
            "Tool call did not start",
        )
        text = _result_text(result) or partial or "No response generated."
        _persist_tool_history(
            repos,
            request["threadId"],
            [*tool_history, *_tool_history_records(result, state)],
        )
        message = repos["chat"]["addMessage"](request["threadId"], "assistant", text)
        checkpoint = _checkpoint_id(state) or request.get("checkpointBefore")
        repos["chat"]["updateAgentState"](request["threadId"], checkpoint, int(deps.get("agentStateVersion", 1)))
        run, _trace = state_machine.transition(
            run_id,
            RUN_STATUS_RUNNING,
            RUN_STATUS_COMPLETED,
            {
                "checkpointAfter": checkpoint,
                "assistantMessageId": message["id"],
                "endedAt": clock(),
            },
            run_trace,
            trace_output=_truncate(text),
        )
        title = request.get("_derivedThreadTitle")
        await emit_event(
            "ai.chat.done",
            {"runId": run_id, "threadId": request["threadId"], "finalText": text},
        )
        await emit_status(run_id, RUN_STATUS_COMPLETED)
        title_source = deps.get("generateTitle") or deps.get("generate_title")
        thread = repos["chat"]["getThread"](request["threadId"])
        fallback_title = request.get("_derivedThreadTitle")
        if (
            title_source is not None
            and isinstance(fallback_title, str)
            and request.get("_isFirstExchange") is True
            and thread
            and thread.get("title") == fallback_title
        ):
            async def generate_title() -> None:
                try:
                    candidate = await _await(
                        title_source(
                            request["threadId"],
                            dict(request.get("provider") or {}),
                        )
                    )
                    current_thread = repos["chat"]["getThread"](request["threadId"])
                    current_run = active_by_thread.get(request["threadId"])
                    if (
                        not isinstance(candidate, str)
                        or not candidate.strip()
                        or current_thread is None
                        or current_thread.get("title") != fallback_title
                        or len(
                            [
                                message
                                for message in repos["chat"]["listMessages"](
                                    request["threadId"]
                                )
                                if message.get("role") == "user"
                            ]
                        ) != 1
                        or current_run not in {None, run_id}
                    ):
                        return
                    resolved = candidate.strip()[:100]
                    repos["chat"]["updateTitle"](request["threadId"], resolved)
                    await emit_event(
                        "ai.chat.title-updated",
                        {"threadId": request["threadId"], "title": resolved},
                    )
                except Exception:
                    return

            task = asyncio.create_task(generate_title())
            title_tasks.add(task)
            task.add_done_callback(title_tasks.discard)
            await asyncio.sleep(0)
            if task.done() and not task.cancelled():
                try:
                    task.result()
                except Exception:
                    pass
                refreshed = repos["chat"]["getThread"](request["threadId"])
                title = refreshed.get("title") if refreshed else None
        return {
            "runId": run_id,
            "status": RUN_STATUS_COMPLETED,
            "run": run,
            "result": result,
            "state": state,
            "title": title,
        }

    async def terminalize(
        request: dict[str, Any],
        status: str,
        error: str,
        run_trace: dict[str, Any] | None,
        partial: str = "",
    ) -> dict[str, Any]:
        run_id = request["runId"]
        await close_open_traces(
            request,
            TRACE_STATUS_CANCELLED
            if status == RUN_STATUS_CANCELLED
            else TRACE_STATUS_ERROR,
            error,
        )
        current = RUN_STATUS_RUNNING
        if run_trace is None:
            persisted = repos["agentRuns"]["get"](run_id)
            current = persisted["status"] if persisted else current
        final_text = partial
        assistant_message = None
        if final_text:
            assistant_message = repos["chat"]["addMessage"](
                request["threadId"], "assistant", final_text
            )
        patch = {"endedAt": clock(), "error": error}
        if assistant_message is not None:
            patch["assistantMessageId"] = assistant_message["id"]
        run, _trace = state_machine.transition(
            run_id,
            current,
            status,
            patch,
            run_trace,
            trace_output=_truncate(final_text or error),
        )
        if status == RUN_STATUS_FAILED:
            error_payload = {
                "runId": run_id,
                "threadId": request["threadId"],
                "message": error,
            }
            if final_text:
                error_payload["partialText"] = final_text
            await emit_event(
                "ai.chat.error",
                error_payload,
            )
        if final_text:
            await emit_event(
                "ai.chat.done",
                {
                    "runId": run_id,
                    "threadId": request["threadId"],
                    "finalText": final_text,
                },
            )
        await emit_status(run_id, status)
        return {"runId": run_id, "status": status, "run": run, "error": error}

    async def restore_interrupted(
        request: dict[str, Any],
        error: str,
        run_trace: dict[str, Any],
    ) -> dict[str, Any]:
        run_id = request["runId"]
        await close_open_traces(request, TRACE_STATUS_ERROR, error)
        run, _trace = state_machine.transition(
            run_id,
            RUN_STATUS_RUNNING,
            RUN_STATUS_INTERRUPTED,
            {"endedAt": None, "error": error},
            run_trace,
            trace_output=_truncate(error),
        )
        await emit_event(
            "ai.chat.error",
            {"runId": run_id, "threadId": request["threadId"], "message": error},
        )
        await emit_status(run_id, RUN_STATUS_INTERRUPTED)
        return {
            "runId": run_id,
            "status": RUN_STATUS_INTERRUPTED,
            "run": run,
            "error": error,
        }

    async def run(request: dict[str, Any], mode: str = "send", existing_run: bool = False) -> dict[str, Any]:
        request = dict(request)
        run_id = request.get("runId")
        thread_id = request.get("threadId")
        if not isinstance(run_id, str) or not run_id or not isinstance(thread_id, str) or not thread_id:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "runId and threadId are required"}
        thread = repos["chat"]["getThread"](thread_id)
        if thread is None:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "Thread not found"}
        provider = request.get("provider") if isinstance(request.get("provider"), dict) else {}
        model = provider.get("model") if isinstance(provider.get("model"), str) else ""
        existing_active = active_by_thread.get(thread_id)
        if mode == "resume" and existing_active not in {None, run_id}:
            message = "Agent is already running for this conversation"
            await emit_event(
                "ai.chat.error",
                {"runId": run_id, "threadId": thread_id, "message": message},
            )
            await emit_status(run_id, RUN_STATUS_INTERRUPTED)
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        if mode == "send" and existing_active not in {None, run_id}:
            active_by_thread[thread_id] = run_id
            previous = active.get(existing_active)
            if previous is not None:
                previous["cancelled"] = True
                previous["stop_reason"] = "superseded"
                previous_agent = previous.get("agent")
                for method_name in ("cancel", "abort", "aclose"):
                    method = getattr(previous_agent, method_name, None)
                    if callable(method):
                        try:
                            await _await(method())
                        except Exception:
                            pass
                        break
                if cancel_run is not None:
                    try:
                        await _await(cancel_run(existing_active))
                    except Exception:
                        pass
        control = {
            "cancelled": False,
            "agent": None,
            "thread_id": thread_id,
            "stop_reason": None,
        }
        active[run_id] = control
        active_by_thread[thread_id] = run_id
        user_message = None
        run_trace: dict[str, Any] | None = None
        checkpoint_connection: aiosqlite.Connection | None = None
        tool_history: list[dict[str, str | None]] = []
        open_tool_traces: dict[str, str] = {}
        open_llm_traces: dict[str, str] = {}
        open_event_traces: dict[str, str] = {}
        seen_streamed_tool_slots: set[str] = set()
        pending_streamed_traces: dict[str, list[str]] = {}
        partial_text = (
            "".join(
                step.get("output") or ""
                for step in repos["agentTraces"]["listByRun"](run_id)
                if step.get("kind") == "message"
            )
            if mode == "recover"
            else ""
        )

        def is_current() -> bool:
            return active_by_thread.get(thread_id) == run_id

        def llm_step_id(event: dict[str, Any]) -> str | None:
            direct = open_llm_traces.get(_event_key(event, "llm"))
            if direct is not None:
                return direct
            parent_ids = event.get("parent_ids")
            if isinstance(parent_ids, list):
                for parent_id in reversed(parent_ids):
                    if isinstance(parent_id, str) and parent_id in open_llm_traces:
                        return open_llm_traces[parent_id]
            return None

        try:
            if mode == "recover":
                await close_open_traces(
                    request,
                    TRACE_STATUS_CANCELLED,
                    "Python sidecar restarted; continuing from the latest checkpoint",
                )
            if not existing_run:
                resume_contexts[run_id] = {
                    key: value
                    for key, value in request.items()
                    if key not in {"messages", "decisions"}
                }
                user_content = ""
                for message in reversed(request.get("messages") or []):
                    if isinstance(message, dict) and message.get("role") in {"user", "human"}:
                        user_content = _message_text(message.get("content"))
                        break

                def persist_new_run() -> None:
                    nonlocal user_message
                    if request.get("replaceLastExchange") is True:
                        repos["chat"]["deleteLastExchange"](thread_id)
                        replace_run_id = request.get("replaceRunId")
                        if isinstance(replace_run_id, str) and replace_run_id:
                            repos["agentTraces"]["deleteByRun"](
                                thread_id, replace_run_id
                            )
                        repos["chat"]["updateAgentState"](
                            thread_id,
                            request.get("checkpointBefore"),
                            int(deps.get("agentStateVersion", 1)),
                        )
                    if user_content:
                        user_message = repos["chat"]["addMessage"](
                            thread_id, "user", user_content
                        )
                    repos["agentRuns"]["create"](
                        {
                            "id": run_id,
                            "threadId": thread_id,
                            "providerId": request.get("providerId")
                            or thread["providerId"],
                            "agentProfileId": request.get("agentProfileId")
                            or thread.get("agentProfileId"),
                            "runtimeSessionId": request.get("runtimeSessionId"),
                            "modelId": model,
                            "activeDocumentId": request.get("activeDocumentId"),
                            "status": RUN_STATUS_QUEUED,
                            "checkpointBefore": request.get("checkpointBefore"),
                            "replacesRunId": request.get("replaceRunId"),
                            "userMessageId": user_message["id"]
                            if user_message
                            else None,
                            "startedAt": clock(),
                        }
                    )

                transaction = repos.get("transaction")
                if callable(transaction):
                    transaction(persist_new_run)
                else:
                    persist_new_run()
                if user_message is not None and not thread.get("title"):
                    fallback_title = derive_thread_title(user_content)
                    repos["chat"]["updateTitle"](thread_id, fallback_title)
                    request["_derivedThreadTitle"] = fallback_title
                    request["_isFirstExchange"] = (
                        len(repos["chat"]["listMessages"](thread_id)) <= 1
                    )
                    await emit_event(
                        "ai.chat.title-updated",
                        {"threadId": thread_id, "title": fallback_title},
                    )
                await emit_status(run_id, RUN_STATUS_QUEUED)
            persisted = repos["agentRuns"]["get"](run_id)
            current_status = persisted["status"] if persisted else RUN_STATUS_QUEUED
            state_machine.transition(run_id, current_status, RUN_STATUS_RUNNING, {"endedAt": None, "error": None})
            await emit_status(run_id, RUN_STATUS_RUNNING)
            run_trace = add_trace(request, 0, "run", "agent", TRACE_STATUS_RUNNING, checkpoint=request.get("checkpointBefore"))
            agent = await create_runtime_agent(request)
            control["agent"] = agent
            checkpoint_connection = await configure_checkpoint(agent, request)
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
            active_content: dict[str, Any] | None = None
            streamed_reasoning: dict[str, str] = {}

            async def observe_streamed_tool_calls(
                value: Any, event: dict[str, Any]
            ) -> None:
                nonlocal seq
                model_run_id = event.get("run_id")
                model_key = model_run_id if isinstance(model_run_id, str) else "model"
                for slot, name in _streamed_tool_call_previews(value):
                    preview_key = f"{model_key}:slot:{slot}"
                    if preview_key in seen_streamed_tool_slots:
                        continue
                    seen_streamed_tool_slots.add(preview_key)
                    await finish_active_content()
                    context = _trace_context(event, open_event_traces)
                    step = add_trace(
                        request,
                        seq,
                        "todo" if name == "write_todos" else "tool",
                        name,
                        TRACE_STATUS_RUNNING,
                        parent_step_id=llm_step_id(event) or context["parentStepId"],
                        agent_name=context["agentName"],
                        namespace=context["namespace"],
                        depth=context["depth"],
                    )
                    pending_streamed_traces.setdefault(name, []).append(step["id"])
                    await emit_trace(request, step)
                    seq += 1

            async def finish_active_content(
                status: str = TRACE_STATUS_DONE,
            ) -> None:
                nonlocal active_content
                if active_content is None:
                    return
                step = repos["agentTraces"]["updateStep"](
                    active_content["id"],
                    {
                        "status": status,
                        "output": active_content["text"],
                        "endedAt": clock(),
                    },
                )
                if step is not None:
                    await emit_trace(request, step)
                active_content = None

            async def append_content(
                kind: str,
                name: str,
                delta: str,
                event: dict[str, Any],
            ) -> str:
                nonlocal active_content, seq
                if active_content is not None and active_content["kind"] != kind:
                    await finish_active_content()
                if active_content is None:
                    context = _trace_context(event, open_event_traces)
                    parent_step_id = llm_step_id(event) or context["parentStepId"]
                    step = add_trace(
                        request,
                        seq,
                        kind,
                        name,
                        TRACE_STATUS_RUNNING,
                        parent_step_id=parent_step_id,
                        agent_name=context["agentName"],
                        namespace=context["namespace"],
                        depth=context["depth"],
                    )
                    seq += 1
                    active_content = {
                        "id": step["id"],
                        "kind": kind,
                        "text": "",
                    }
                    await emit_trace(request, step)
                active_content["text"] += delta
                repos["agentTraces"]["updateStep"](
                    active_content["id"],
                    {"output": active_content["text"]},
                )
                return active_content["id"]

            async def emit_reasoning_delta(
                delta: str,
                event: dict[str, Any],
                *,
                track: bool = True,
            ) -> None:
                if track:
                    event_key = _event_key(event, "llm")
                    streamed_reasoning[event_key] = (
                        streamed_reasoning.get(event_key, "") + delta
                    )
                step_id = await append_content(
                    "reasoning",
                    "model_reasoning",
                    delta,
                    event,
                )
                payload = {
                    "runId": run_id,
                    "threadId": thread_id,
                    "token": delta,
                }
                if step_id is not None:
                    payload["stepId"] = step_id
                await emit_event("ai.chat.reasoning", payload)

            async for raw in events:
                if control["cancelled"]:
                    reason = (
                        "Cancelled because a newer run replaced this run"
                        if control.get("stop_reason") == "superseded"
                        else "Cancelled"
                    )
                    return await terminalize(
                        request,
                        RUN_STATUS_CANCELLED,
                        reason,
                        run_trace,
                        partial_text if is_current() else "",
                    )
                event = raw if isinstance(raw, dict) else {"event": "trace", "data": raw}
                event_name = str(event.get("event") or event.get("type") or "")
                if event_name in {"token", "on_chat_model_stream", "on_tool_call_chunk"}:
                    event_data = event.get("data")
                    if isinstance(event_data, dict):
                        await observe_streamed_tool_calls(
                            event_data.get("chunk", event_data), event
                        )
                    if event.get("new_message") is True:
                        await finish_active_content()
                    reasoning_delta = _event_delta(event, True)
                    if reasoning_delta:
                        await emit_reasoning_delta(reasoning_delta, event)
                    delta = _event_delta(event, False)
                    if delta:
                        starts_message_segment = (
                            active_content is None
                            or active_content["kind"] != "message"
                        )
                        separator = (
                            _segment_separator(partial_text, delta)
                            if starts_message_segment
                            else ""
                        )
                        partial_text += separator + delta
                        step_id = await append_content(
                            "message",
                            "assistant_message",
                            delta,
                            event,
                        )
                        payload = {
                            "runId": run_id,
                            "threadId": thread_id,
                            "token": separator + delta,
                        }
                        if step_id is not None:
                            payload["stepId"] = step_id
                        await emit_event("ai.chat.token", payload)
                    continue
                if event_name in {"reasoning", "thinking"}:
                    delta = _event_delta(event, True)
                    if not delta and isinstance(event.get("delta"), str):
                        delta = event["delta"]
                    if delta:
                        await emit_reasoning_delta(delta, event)
                    continue
                if event_name == "on_chat_model_start":
                    await finish_active_content()
                    context = _trace_context(event, open_event_traces)
                    step = add_trace(
                        request,
                        seq,
                        "llm",
                        _tool_event_name(event) or "model",
                        TRACE_STATUS_RUNNING,
                        checkpoint=_checkpoint_id(event),
                        input_data=(event.get("data") or {}).get("input")
                        if isinstance(event.get("data"), dict)
                        else None,
                        parent_step_id=context["parentStepId"],
                        agent_name=context["agentName"],
                        namespace=context["namespace"],
                        depth=context["depth"],
                    )
                    event_key = _event_key(event, "llm")
                    open_llm_traces[event_key] = step["id"]
                    open_event_traces[event_key] = step["id"]
                    await emit_trace(request, step)
                    seq += 1
                    continue
                if event_name in {"on_chat_model_end", "on_chat_model_error"}:
                    failed = event_name == "on_chat_model_error"
                    detail = event.get("error")
                    event_data = event.get("data")
                    if isinstance(event_data, dict):
                        await observe_streamed_tool_calls(event_data.get("output"), event)
                    if detail is None and isinstance(event_data, dict):
                        detail = event_data.get("error") or event_data.get("output")
                    event_key = _event_key(event, "llm")
                    if not failed and isinstance(event_data, dict):
                        final_reasoning = _chunk_reasoning_text(
                            event_data.get("output")
                        )
                        streamed = streamed_reasoning.pop(event_key, "")
                        if final_reasoning and not streamed:
                            await emit_reasoning_delta(
                                final_reasoning,
                                event,
                                track=False,
                            )
                        elif final_reasoning.startswith(streamed):
                            remaining = final_reasoning[len(streamed):]
                            if remaining:
                                await emit_reasoning_delta(
                                    remaining,
                                    event,
                                    track=False,
                                )
                    else:
                        streamed_reasoning.pop(event_key, None)
                    trace_id = open_llm_traces.pop(event_key, None)
                    open_event_traces.pop(event_key, None)
                    patch = {
                        "status": TRACE_STATUS_ERROR if failed else TRACE_STATUS_DONE,
                        "output": _truncate(detail),
                        "endedAt": clock(),
                        **_token_usage(event_data),
                    }
                    step = (
                        repos["agentTraces"]["updateStep"](trace_id, patch)
                        if trace_id is not None
                        else add_trace(
                            request,
                            seq,
                            "llm",
                            _tool_event_name(event) or "model",
                            patch["status"],
                            detail,
                            _checkpoint_id(event),
                        )
                    )
                    if trace_id is None:
                        seq += 1
                    if step is not None:
                        await emit_trace(request, step)
                    if failed:
                        raise RuntimeError(_as_text(detail or "Model execution failed"))
                    continue
                if event_name in {"done", "complete", "result"}:
                    result = event.get("result", event.get("data"))
                    candidate_state = event.get("state")
                    if isinstance(candidate_state, dict):
                        state = candidate_state
                    continue
                if event_name == "on_chain_end":
                    data = event.get("data")
                    if isinstance(data, dict) and data.get("output") is not None:
                        result = data["output"]
                if event_name == "on_tool_start":
                    await finish_active_content()
                    name = _tool_event_name(event)
                    trace_input, _ = _tool_event_values(event)
                    context = _trace_context(event, open_event_traces)
                    is_subagent = name == "task"
                    pending = pending_streamed_traces.get(name or "")
                    trace_id = pending.pop(0) if pending else None
                    if pending is not None and not pending:
                        pending_streamed_traces.pop(name or "", None)
                    if trace_id is not None:
                        step = repos["agentTraces"]["updateStep"](
                            trace_id,
                            {"input": _truncate(_without_secrets(trace_input))},
                        )
                    else:
                        step = add_trace(
                            request,
                            seq,
                            "subagent"
                            if is_subagent
                            else ("todo" if name == "write_todos" else "tool"),
                            name,
                            TRACE_STATUS_RUNNING,
                            checkpoint=_checkpoint_id(event),
                            input_data=trace_input,
                            parent_step_id=context["parentStepId"],
                            agent_name=_subagent_name(event)
                            if is_subagent
                            else context["agentName"],
                            namespace=context["namespace"],
                            depth=context["depth"],
                        )
                        seq += 1
                    event_key = _tool_event_key(event, name)
                    if step is not None:
                        open_tool_traces[event_key] = step["id"]
                        open_event_traces[event_key] = step["id"]
                        await emit_trace(request, step)
                    continue
                if event_name == "on_tool_end":
                    await finish_active_content()
                    record = _tool_event_record(event)
                    if record is not None:
                        tool_history.append(record)
                    name = _tool_event_name(event)
                    _, trace_output = _tool_event_values(event)
                    safe_output = (
                        ACADEMIC_PERSISTENCE_REDACTION
                        if _is_academic_tool_name(name)
                        else _without_secrets(trace_output)
                    )
                    failed = _tool_output_failed(trace_output)
                    status = TRACE_STATUS_ERROR if failed else TRACE_STATUS_DONE
                    event_key = _tool_event_key(event, name)
                    trace_id = open_tool_traces.pop(event_key, None)
                    open_event_traces.pop(event_key, None)
                    if trace_id is not None:
                        step = repos["agentTraces"]["updateStep"](
                            trace_id,
                            {
                                "status": status,
                                "output": _truncate(safe_output),
                                "endedAt": clock(),
                            },
                        )
                    else:
                        step = add_trace(
                            request,
                            seq,
                            "subagent"
                            if name == "task"
                            else ("todo" if name == "write_todos" else "tool"),
                            name,
                            status,
                            trace_output,
                            _checkpoint_id(event),
                        )
                        seq += 1
                    if step is not None:
                        await emit_trace(request, step)
                    continue
                if event_name == "on_tool_error":
                    await finish_active_content()
                    record = _tool_event_record(event)
                    if record is not None:
                        tool_history.append(record)
                    name = _tool_event_name(event)
                    _, trace_output = _tool_event_values(event)
                    detail = event.get("error") or trace_output or event.get("data") or "Agent execution failed"
                    safe_output = (
                        ACADEMIC_PERSISTENCE_REDACTION
                        if _is_academic_tool_name(name)
                        else _without_secrets(detail)
                    )
                    event_key = _tool_event_key(event, name)
                    trace_id = open_tool_traces.pop(event_key, None)
                    open_event_traces.pop(event_key, None)
                    if trace_id is not None:
                        step = repos["agentTraces"]["updateStep"](
                            trace_id,
                            {
                                "status": TRACE_STATUS_ERROR,
                                "output": _truncate(safe_output),
                                "endedAt": clock(),
                            },
                        )
                    else:
                        step = add_trace(
                            request,
                            seq,
                            "subagent"
                            if name == "task"
                            else ("todo" if name == "write_todos" else "tool"),
                            name,
                            TRACE_STATUS_ERROR,
                            detail,
                            _checkpoint_id(event),
                        )
                        seq += 1
                    if step is not None:
                        await emit_trace(request, step)
                    raise RuntimeError(_as_text(detail))
                if event_name in {"error", "on_chain_error"}:
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
                checkpoint = _checkpoint_id(event)
                context = _trace_context(event, open_event_traces)
                step = add_trace(
                    request,
                    seq,
                    "tool" if "tool" in event_name else "llm",
                    event.get("name")
                    if isinstance(event.get("name"), str)
                    else event_name or "agent",
                    TRACE_STATUS_DONE,
                    event.get("data"),
                    checkpoint,
                    parent_step_id=context["parentStepId"],
                    agent_name=context["agentName"],
                    namespace=context["namespace"],
                    depth=context["depth"],
                )
                await emit_trace(request, step)
                seq += 1
            if control["cancelled"]:
                reason = (
                    "Cancelled because a newer run replaced this run"
                    if control.get("stop_reason") == "superseded"
                    else "Cancelled"
                )
                return await terminalize(
                    request,
                    RUN_STATUS_CANCELLED,
                    reason,
                    run_trace,
                    partial_text if is_current() else "",
                )
            if not is_current():
                return await terminalize(
                    request,
                    RUN_STATUS_CANCELLED,
                    "Cancelled because a newer run replaced this run",
                    run_trace,
                )
            snapshot = await agent_state(agent, request)
            if not is_current():
                return await terminalize(
                    request,
                    RUN_STATUS_CANCELLED,
                    "Cancelled because a newer run replaced this run",
                    run_trace,
                )
            if snapshot:
                state = snapshot
                values = snapshot.get("values")
                if isinstance(values, dict) and values.get("messages"):
                    result = values
            interrupt_id = request.get("resolveInterruptId")
            if isinstance(interrupt_id, str) and interrupt_id:
                repos["agentInterrupts"]["resolve"](
                    interrupt_id,
                    request.get("resolveInterruptDecisions") or [],
                )
            if interrupted or _interrupt_actions(state):
                await finish_active_content()
                return await finish_interrupted(request, state, run_trace)
            await finish_active_content()
            return await finish_completed(
                request,
                result,
                state,
                run_trace,
                tool_history,
                partial_text,
            )
        except asyncio.CancelledError:
            return await terminalize(
                request,
                RUN_STATUS_CANCELLED,
                "Cancelled",
                run_trace,
                partial_text if is_current() else "",
            )
        except Exception as error:
            message = _as_text(error)
            api_key = provider.get("apiKey") if isinstance(provider, dict) else None
            if isinstance(api_key, str) and api_key:
                message = message.replace(api_key, "[redacted]")
            warn(f"agent runtime failed run={run_id}")
            if (
                mode == "resume"
                and isinstance(request.get("resolveInterruptId"), str)
                and run_trace is not None
                and not control["cancelled"]
            ):
                return await restore_interrupted(
                    request,
                    message or "Agent resume failed",
                    run_trace,
                )
            return await terminalize(
                request,
                RUN_STATUS_CANCELLED if control["cancelled"] else RUN_STATUS_FAILED,
                message or "Agent execution failed",
                run_trace,
                partial_text if is_current() else "",
            )
        finally:
            active.pop(run_id, None)
            if active_by_thread.get(thread_id) == run_id:
                active_by_thread.pop(thread_id, None)
            if finish_run is not None:
                try:
                    await _await(finish_run(run_id))
                except Exception:
                    pass
            if checkpoint_connection is not None:
                await checkpoint_connection.close()
            persisted = repos["agentRuns"]["get"](run_id)
            if persisted is None or persisted.get("status") != RUN_STATUS_INTERRUPTED:
                resume_contexts.pop(run_id, None)

    async def send(request: dict[str, Any]) -> dict[str, Any]:
        return await run(request, "send")

    async def start(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        if run_id in background_tasks and not background_tasks[run_id].done():
            raise ValueError("Run is already active")
        task = asyncio.create_task(send(request))
        background_tasks[run_id] = task
        task.add_done_callback(lambda completed, rid=run_id: background_tasks.pop(rid, None))
        await asyncio.sleep(0)
        return {"runId": run_id, "threadId": request["threadId"]}

    async def resume(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request.get("runId")
        if not isinstance(run_id, str) or not run_id:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "runId is required"}
        persisted = repos["agentRuns"]["get"](run_id)
        interrupt = repos["agentInterrupts"]["getPendingByRun"](run_id)
        if persisted is None or interrupt is None:
            message = "No pending interrupt for run"
            if persisted is not None:
                await emit_event(
                    "ai.chat.error",
                    {
                        "runId": run_id,
                        "threadId": persisted["threadId"],
                        "message": message,
                    },
                )
                await emit_status(run_id, persisted["status"])
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        decisions = request.get("decisions")
        if not isinstance(decisions, list) or len(decisions) != len(interrupt["actions"]):
            message = "Interrupt decisions do not match pending actions"
            await emit_event(
                "ai.chat.error",
                {
                    "runId": run_id,
                    "threadId": persisted["threadId"],
                    "message": message,
                },
            )
            await emit_status(run_id, persisted["status"])
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        thread = repos["chat"]["getThread"](persisted["threadId"])
        try:
            normalized_decisions = [
                _resume_decision(
                    decision,
                    action,
                    thread.get("workspaceId") if thread else None,
                )
                for decision, action in zip(decisions, interrupt["actions"])
            ]
        except ValueError as error:
            message = str(error)
            await emit_event(
                "ai.chat.error",
                {
                    "runId": run_id,
                    "threadId": persisted["threadId"],
                    "message": message,
                },
            )
            await emit_status(run_id, persisted["status"])
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        stored = resume_contexts.get(run_id, {})
        request = {
            **request,
            **stored,
            "decisions": normalized_decisions,
            "cliApprovalReplay": [
                {
                    "name": action["name"],
                    "args": action.get("args") or {},
                    "decision": decision,
                }
                for action, decision in zip(interrupt["actions"], normalized_decisions)
            ],
            "resolveInterruptId": interrupt["id"],
            "resolveInterruptDecisions": decisions,
            "threadId": persisted["threadId"],
            "workspaceId": stored.get("workspaceId")
            if "workspaceId" in stored
            else (thread.get("workspaceId") if thread else None),
            "checkpointBefore": interrupt.get("checkpointId")
            or persisted.get("checkpointAfter"),
        }
        return await run(request, "resume", existing_run=True)

    async def start_resume(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        if run_id in background_tasks and not background_tasks[run_id].done():
            raise ValueError("Run is already active")
        task = asyncio.create_task(resume(request))
        background_tasks[run_id] = task
        task.add_done_callback(lambda completed, rid=run_id: background_tasks.pop(rid, None))
        await asyncio.sleep(0)
        return {"runId": run_id}

    async def recover(request: dict[str, Any]) -> dict[str, Any]:
        checkpoint_path = request.get("checkpointPath")
        if isinstance(checkpoint_path, str) and checkpoint_path:
            try:
                await asyncio.to_thread(_prune_academic_artifacts, checkpoint_path)
            except OSError:
                pass
        mode = (
            "recover"
            if request.get("recoverLatestCheckpoint") is True
            else "restart"
        )
        return await run(request, mode, existing_run=True)

    async def start_recover(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        if run_id in background_tasks and not background_tasks[run_id].done():
            raise ValueError("Run is already active")
        task = asyncio.create_task(recover(request))
        background_tasks[run_id] = task
        task.add_done_callback(
            lambda completed, rid=run_id: background_tasks.pop(rid, None)
        )
        await asyncio.sleep(0)
        return {"runId": run_id, "threadId": request["threadId"]}

    async def cancel(run_id: str) -> dict[str, Any]:
        if cancel_run is not None:
            try:
                await _await(cancel_run(run_id))
            except Exception:
                pass
        control = active.get(run_id)
        if control is None:
            run = repos["agentRuns"]["get"](run_id)
            if run is None or is_terminal_run(run["status"]):
                return {"runId": run_id, "cancelled": False}
            request = {"runId": run_id, "threadId": run["threadId"]}
            await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", None)
            resume_contexts.pop(run_id, None)
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

    async def delete_thread(thread_id: str) -> None:
        runs = repos["agentRuns"]["listByThread"](thread_id)
        run_ids = [
            run["id"]
            for run in runs
            if isinstance(run.get("id"), str)
        ]
        for run_id in run_ids:
            run = repos["agentRuns"]["get"](run_id)
            if (
                run_id in background_tasks
                or run_id in active
                or (run is not None and run.get("status") == RUN_STATUS_INTERRUPTED)
            ):
                await cancel(run_id)
        tasks = [
            background_tasks[run_id]
            for run_id in run_ids
            if run_id in background_tasks
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for run_id in run_ids:
            background_tasks.pop(run_id, None)
            resume_contexts.pop(run_id, None)

        checkpoint_path = deps.get("checkpointPath") or deps.get("checkpoint_path")
        if not isinstance(checkpoint_path, str) or not os.path.isfile(checkpoint_path):
            return
        artifact_store = AcademicArtifactStore(
            _checkpoint_artifact_root(checkpoint_path)
        )
        candidate_artifact_ids = _artifact_ids_in_checkpoint_database(
            checkpoint_path, thread_id
        )
        connection = sqlite3.connect(checkpoint_path)
        try:
            connection.execute("PRAGMA busy_timeout = 5000")
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            if {"checkpoints", "writes"}.issubset(tables):
                with connection:
                    connection.execute(
                        "DELETE FROM writes WHERE thread_id = ?",
                        [thread_id],
                    )
                    connection.execute(
                        "DELETE FROM checkpoints WHERE thread_id = ?",
                        [thread_id],
                    )
        finally:
            connection.close()
        artifact_store.delete_thread_artifacts(
            candidate_artifact_ids,
            _artifact_ids_in_checkpoint_database(checkpoint_path),
        )

    async def destroy() -> None:
        for run_id, control in active.items():
            control["cancelled"] = True
            if cancel_run is not None:
                try:
                    await _await(cancel_run(run_id))
                except Exception:
                    pass
        tasks = list(background_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        pending_titles = list(title_tasks)
        for task in pending_titles:
            task.cancel()
        if pending_titles:
            await asyncio.gather(*pending_titles, return_exceptions=True)
        background_tasks.clear()
        title_tasks.clear()
        resume_contexts.clear()

    return {
        "send": send,
        "start": start,
        "run": run,
        "resume": resume,
        "startResume": start_resume,
        "recover": recover,
        "startRecover": start_recover,
        "cancel": cancel,
        "deleteThread": delete_thread,
        "destroy": destroy,
    }


async def _iterate(values: Iterable[Any]):
    for value in values:
        yield value
