from __future__ import annotations

import asyncio
import copy
import multiprocessing as mp
import os
import tempfile
import traceback
from pathlib import Path
from typing import Any

from search_evals.harnesses.base import BaseHarness, HarnessRequest, NonRetryableHarnessError
from search_evals.harnesses.openrouter_common import normalize_openrouter_model
from search_evals.io import write_json
from search_evals.schemas import HarnessCost, HarnessResult, HermesParams, TokenUsage


class HermesHarness(BaseHarness):
    """Hermes Agent harness using OpenRouter for model and web search.

    Hermes' built-in web toolset is intentionally not used here: those tools
    require separate search-provider keys. Instead, OpenRouter's server-side
    web-search extensions are passed through the OpenAI SDK via ``extra_body``.
    That keeps the run on the same ``OPENROUTER_API_KEY``-only surface as the
    existing OpenRouter benchmark harness.
    """

    required_env = ("OPENROUTER_API_KEY",)

    def __init__(self, system_name: str, params: HermesParams) -> None:
        super().__init__(system_name, params)
        self.params = params
        self.model = normalize_openrouter_model(params.model)

    async def preflight(self) -> None:
        await super().preflight()
        try:
            from run_agent import AIAgent  # noqa: F401
        except ImportError as error:
            raise NonRetryableHarnessError(
                "Hermes Agent is not installed. Install it with: "
                "uv pip install 'git+https://github.com/NousResearch/hermes-agent.git'"
            ) from error
        if self.params.provider != "openrouter":
            raise NonRetryableHarnessError("Hermes benchmark harness currently supports provider='openrouter' only")

    async def run(self, request: HarnessRequest) -> HarnessResult:
        request_payload = self._request_payload(request)
        write_json(request.attempt_dir / "agent" / "request.json", request_payload)

        result = await self._run_cancellable(request, request_payload["request_overrides"])
        write_json(request.attempt_dir / "agent" / "response.json", result)

        answer = str(result.get("final_response") or "").strip()
        cost = self._cost_from_result(result)
        self.record_cost(request.attempt_dir, cost)
        harness_result = HarnessResult(
            answer=answer,
            provider=self.system_name,
            model=str(result.get("model") or self.model),
            response_id=str(result.get("task_id") or request.task_id),
            tool_calls=tuple(_extract_tool_calls(result.get("messages", []))),
            cost=cost,
            search_metrics=_search_metrics(result),
        )
        write_json(request.attempt_dir / "agent" / "result.json", harness_result.to_dict())
        return harness_result

    def _request_payload(self, request: HarnessRequest) -> dict[str, Any]:
        request_overrides = self._request_overrides()
        return {
            "model": self.model,
            "provider": self.params.provider,
            "max_iterations": self.params.max_iterations,
            "enabled_toolsets": list(self.params.enabled_toolsets),
            "disabled_toolsets": list(self.params.disabled_toolsets or ()),
            "skip_context_files": self.params.skip_context_files,
            "skip_memory": self.params.skip_memory,
            "task_id": request.task_id,
            "request_overrides": request_overrides,
        }

    async def _run_cancellable(self, request: HarnessRequest, request_overrides: dict[str, Any]) -> dict[str, Any]:
        """Run Hermes in a child process so runner timeouts can stop streams.

        Hermes is synchronous internally. If it runs in ``asyncio.to_thread()``,
        ``asyncio.wait_for`` can mark the task timed out but cannot kill the
        worker thread, leaving the OpenRouter stream alive and the process stuck.
        A child process gives the runner an actual cancellation boundary.
        """

        ctx = mp.get_context("spawn")
        queue: mp.Queue[dict[str, Any]] = ctx.Queue(maxsize=1)
        process = ctx.Process(
            target=_run_hermes_child,
            args=(self.system_name, self.params.model_dump(mode="json"), _request_dict(request), request_overrides, queue),
        )
        process.start()
        try:
            while process.is_alive():
                try:
                    payload = queue.get_nowait()
                except Exception:
                    await asyncio.sleep(0.25)
                    continue
                process.join(timeout=5)
                if process.is_alive():
                    _terminate_process(process)
                return _child_payload_result(payload)
            process.join(timeout=5)
            if process.is_alive():
                _terminate_process(process)
            try:
                payload = queue.get_nowait()
            except Exception as error:
                raise RuntimeError(f"Hermes child process exited with code {process.exitcode}") from error
            return _child_payload_result(payload)
        except asyncio.CancelledError:
            _terminate_process(process)
            raise
        finally:
            queue.close()
            queue.join_thread()

    def _run_sync(self, request: HarnessRequest, request_overrides: dict[str, Any]) -> dict[str, Any]:
        from run_agent import AIAgent
        from tools.registry import discover_builtin_tools

        discover_builtin_tools()
        with tempfile.TemporaryDirectory(prefix="search-evals-hermes-") as home:
            old_home = os.environ.get("HERMES_HOME")
            os.environ["HERMES_HOME"] = home
            self._write_hermes_config(Path(home))
            try:
                agent = AIAgent(
                    model=self.model,
                    provider=self.params.provider,
                    quiet_mode=True,
                    max_iterations=self.params.max_iterations,
                    enabled_toolsets=list(self.params.enabled_toolsets),
                    disabled_toolsets=list(self.params.disabled_toolsets) if self.params.disabled_toolsets else None,
                    skip_context_files=self.params.skip_context_files,
                    skip_memory=self.params.skip_memory,
                    max_tokens=self.params.max_tokens,
                    reasoning_config=self._reasoning_config(),
                    providers_order=list(self.params.provider_order) if self.params.provider_order else None,
                    providers_ignored=list(self.params.provider_ignore) if self.params.provider_ignore else None,
                    providers_allowed=list(self.params.providers_allowed) if self.params.providers_allowed else None,
                    request_overrides=copy.deepcopy(request_overrides),
                )
                result = agent.run_conversation(
                    user_message=request.problem,
                    system_message=request.instructions,
                    task_id=request.task_id,
                )
                result.update(
                    {
                        "task_id": request.task_id,
                        "model": getattr(agent, "model", self.model),
                        "provider": getattr(agent, "provider", self.params.provider),
                        "session_usage": self._session_usage(agent),
                        "session_cost": {
                            "estimated_cost_usd": getattr(agent, "session_estimated_cost_usd", 0.0),
                            "status": getattr(agent, "session_cost_status", "unknown"),
                            "source": getattr(agent, "session_cost_source", "none"),
                        },
                    }
                )
                return result
            finally:
                if old_home is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = old_home

    def _write_hermes_config(self, home: Path) -> None:
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(
            "model:\n"
            f"  provider: {self.params.provider}\n"
            f"  model: {self.model}\n"
            "tools:\n"
            "  auto_discover: false\n",
            encoding="utf-8",
        )

    def _reasoning_config(self) -> dict[str, Any] | None:
        if self.params.reasoning_effort is None:
            return None
        if self.params.reasoning_effort == "none":
            return {"enabled": False, "effort": "none"}
        return {"enabled": True, "effort": self.params.reasoning_effort}

    def _request_overrides(self) -> dict[str, Any]:
        extra_body: dict[str, Any] = {}
        if self.params.web_search == "server-tool":
            tools = [self._server_tool_def()]
            if self.params.web_fetch:
                tools.append(self._web_fetch_def())
            extra_body["tools"] = tools
            if self.params.max_tool_calls is not None:
                extra_body["stop_server_tools_when"] = [
                    {"type": "step_count_is", "step_count": self.params.max_tool_calls}
                ]
        elif self.params.web_search == "plugin":
            extra_body["plugins"] = [self._plugin_def()]

        provider_prefs = self._provider_prefs()
        if provider_prefs:
            extra_body["provider"] = provider_prefs
        return {"extra_body": extra_body} if extra_body else {}

    def _provider_prefs(self) -> dict[str, Any]:
        prefs: dict[str, Any] = {}
        if self.params.provider_order is not None:
            prefs["order"] = list(self.params.provider_order)
            allow = self.params.provider_allow_fallbacks
            prefs["allow_fallbacks"] = True if allow is None else allow
        if self.params.provider_ignore:
            prefs["ignore"] = list(self.params.provider_ignore)
        return prefs

    def _server_tool_def(self) -> dict[str, Any]:
        parameters: dict[str, Any] = {}
        if self.params.max_results_per_search != "default":
            parameters["max_results"] = self.params.max_results_per_search
        if self.params.max_total_results is not None:
            parameters["max_total_results"] = self.params.max_total_results
        if self.params.search_backend is not None:
            parameters["engine"] = self.params.search_backend
        if self.params.search_context_size is not None and self.params.max_characters is None:
            parameters["search_context_size"] = self.params.search_context_size
        if self.params.max_characters is not None:
            parameters["max_characters"] = self.params.max_characters
        if self.params.allowed_domains:
            parameters["allowed_domains"] = list(self.params.allowed_domains)
        if self.params.excluded_domains:
            parameters["excluded_domains"] = list(self.params.excluded_domains)
        return {"type": "openrouter:web_search", "parameters": parameters}

    def _web_fetch_def(self) -> dict[str, Any]:
        parameters: dict[str, Any] = {}
        if self.params.fetch_engine is not None:
            parameters["engine"] = self.params.fetch_engine
        if self.params.max_fetch_uses is not None:
            parameters["max_uses"] = self.params.max_fetch_uses
        if self.params.max_fetch_content_tokens is not None:
            parameters["max_content_tokens"] = self.params.max_fetch_content_tokens
        tool: dict[str, Any] = {"type": "openrouter:web_fetch"}
        if parameters:
            tool["parameters"] = parameters
        return tool

    def _plugin_def(self) -> dict[str, Any]:
        plugin: dict[str, Any] = {"id": "web"}
        if self.params.max_results_per_search != "default":
            plugin["max_results"] = self.params.max_results_per_search
        if self.params.search_backend is not None:
            plugin["engine"] = self.params.search_backend
        if self.params.allowed_domains:
            plugin["include_domains"] = list(self.params.allowed_domains)
        if self.params.excluded_domains:
            plugin["exclude_domains"] = list(self.params.excluded_domains)
        return plugin

    @staticmethod
    def _session_usage(agent: Any) -> dict[str, int]:
        return {
            "input_tokens": int(getattr(agent, "session_input_tokens", 0) or 0),
            "output_tokens": int(getattr(agent, "session_output_tokens", 0) or 0),
            "total_tokens": int(getattr(agent, "session_total_tokens", 0) or 0),
            "cached_input_tokens": int(getattr(agent, "session_cache_read_tokens", 0) or 0),
            "cache_write_tokens": int(getattr(agent, "session_cache_write_tokens", 0) or 0),
            "reasoning_tokens": int(getattr(agent, "session_reasoning_tokens", 0) or 0),
            "api_calls": int(getattr(agent, "session_api_calls", 0) or 0),
        }

    def _cost_from_result(self, result: dict[str, Any]) -> HarnessCost:
        usage = result.get("session_usage") if type(result.get("session_usage")) is dict else {}
        token_usage = TokenUsage(
            input_tokens=int(usage.get("input_tokens", 0) or 0),
            output_tokens=int(usage.get("output_tokens", 0) or 0),
            total_tokens=int(usage.get("total_tokens", 0) or 0),
            cached_input_tokens=int(usage.get("cached_input_tokens", 0) or 0),
            reasoning_tokens=int(usage.get("reasoning_tokens", 0) or 0),
        )
        session_cost = result.get("session_cost") if type(result.get("session_cost")) is dict else {}
        estimated = session_cost.get("estimated_cost_usd")
        try:
            cost = float(estimated)
        except (TypeError, ValueError):
            cost = 0.0
        cost_source = str(session_cost.get("source") or "hermes")
        if cost <= 0:
            estimated_cost = _estimate_openrouter_model_cost(self.model, usage)
            if estimated_cost is not None:
                cost = estimated_cost
                cost_source = "hermes_openrouter_model_estimate"
        known = cost > 0 or session_cost.get("status") not in {None, "unknown"}
        return HarnessCost(
            currency="USD",
            usage=token_usage.to_dict(),
            usd={cost_source: cost} if known else {},
            cost_known=known,
        )


def _extract_tool_calls(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return []
    calls: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list):
            calls.extend(item for item in tool_calls if isinstance(item, dict))
    return calls


def _search_metrics(result: dict[str, Any]) -> dict[str, int | float]:
    messages = result.get("messages", [])
    calls = _extract_tool_calls(messages)
    web_calls = [call for call in calls if "web" in str(call.get("function", call.get("name", ""))).lower()]
    usage = result.get("session_usage") if type(result.get("session_usage")) is dict else {}
    return {
        "api_calls": int(result.get("api_calls", usage.get("api_calls", 0)) or 0),
        "tool_calls": len(calls),
        "web_tool_calls": len(web_calls),
        "reasoning_tokens": int(usage.get("reasoning_tokens", 0) or 0),
    }


def _estimate_openrouter_model_cost(model: str, usage: dict[str, Any]) -> float | None:
    """Estimate model-token cost when Hermes cannot price an OpenRouter slug.

    OpenRouter can serve variants such as ``:nitro`` before they appear in the
    public models catalog. Hermes' pricing helper then returns unknown even
    though the base model pricing exists. This estimate intentionally covers
    model tokens only; OpenRouter server-tool/search add-ons, if any, remain
    outside the estimate because Hermes does not expose the raw response body.
    """
    try:
        from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
    except ImportError:
        return None

    canonical = CanonicalUsage(
        input_tokens=int(usage.get("input_tokens", 0) or 0),
        output_tokens=int(usage.get("output_tokens", 0) or 0),
        cache_read_tokens=int(usage.get("cached_input_tokens", 0) or 0),
        cache_write_tokens=int(usage.get("cache_write_tokens", 0) or 0),
        reasoning_tokens=int(usage.get("reasoning_tokens", 0) or 0),
    )
    candidates = [model]
    if ":" in model:
        candidates.append(model.split(":", 1)[0])
    for candidate in candidates:
        cost = estimate_usage_cost(
            candidate,
            canonical,
            provider="openrouter",
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        )
        if cost.amount_usd is not None:
            return float(cost.amount_usd)
    return None


def _request_dict(request: HarnessRequest) -> dict[str, str]:
    return {
        "task_id": request.task_id,
        "suite": request.suite,
        "problem": request.problem,
        "instructions": request.instructions,
        "attempt_dir": str(request.attempt_dir),
        "run_dir": str(request.run_dir),
    }


def _request_from_dict(raw: dict[str, str]) -> HarnessRequest:
    return HarnessRequest(
        task_id=raw["task_id"],
        suite=raw["suite"],
        problem=raw["problem"],
        instructions=raw["instructions"],
        attempt_dir=Path(raw["attempt_dir"]),
        run_dir=Path(raw["run_dir"]),
    )


def _run_hermes_child(
    system_name: str,
    params_raw: dict[str, Any],
    request_raw: dict[str, str],
    request_overrides: dict[str, Any],
    queue: mp.Queue,
) -> None:
    try:
        harness = HermesHarness(system_name, HermesParams.model_validate(params_raw))
        result = harness._run_sync(_request_from_dict(request_raw), request_overrides)
        queue.put({"ok": True, "result": result})
    except BaseException as error:
        queue.put(
            {
                "ok": False,
                "type": type(error).__name__,
                "message": str(error),
                "traceback": traceback.format_exc(),
            }
        )


def _child_payload_result(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("ok") is True and type(payload.get("result")) is dict:
        return payload["result"]
    message = str(payload.get("message") or "Hermes child process failed")
    error_type = str(payload.get("type") or "RuntimeError")
    raise RuntimeError(f"Hermes child process failed ({error_type}): {message}")


def _terminate_process(process: mp.Process) -> None:
    if not process.is_alive():
        process.join(timeout=1)
        return
    process.terminate()
    process.join(timeout=5)
    if process.is_alive():
        process.kill()
        process.join(timeout=5)
