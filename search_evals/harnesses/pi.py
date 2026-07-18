from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Any

from search_evals.harnesses.base import (
    BaseHarness,
    HarnessRequest,
    NonRetryableHarnessError,
    TerminalHarnessResponseError,
)
from search_evals.harnesses.openrouter_common import int_usage_value, nested_usage_value, openrouter_usage_cost
from search_evals.io import write_json
from search_evals.schemas import HarnessCost, HarnessResult, PiParams, TokenUsage


class PiHarness(BaseHarness):
    """Pi SDK harness backed by a small Node runner.

    Pi's SDK is published as a JavaScript package, so the Python runner keeps
    process isolation and exchanges JSON artifacts with ``pi_runner.mjs``.
    """

    required_env = ("OPENROUTER_API_KEY",)

    def __init__(self, system_name: str, params: PiParams) -> None:
        super().__init__(system_name, params)
        self.params = params

    async def preflight(self) -> None:
        await super().preflight()
        if shutil.which("node") is None:
            raise NonRetryableHarnessError("Pi harness requires Node.js on PATH")
        package_check = await asyncio.create_subprocess_exec(
            "node",
            "-e",
            "import('@earendil-works/pi-coding-agent')",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await package_check.communicate()
        if package_check.returncode != 0:
            raise NonRetryableHarnessError(
                "Pi harness requires @earendil-works/pi-coding-agent. Install with: "
                "npm install @earendil-works/pi-coding-agent\n"
                + stderr.decode(errors="replace")[-1000:]
            )

    async def run(self, request: HarnessRequest) -> HarnessResult:
        input_path = request.attempt_dir / "agent" / "pi-request.json"
        output_path = request.attempt_dir / "agent" / "response.json"
        input_payload = {
            "task_id": request.task_id,
            "suite": request.suite,
            "problem": request.problem,
            "instructions": request.instructions,
            "params": self.params.model_dump(mode="json", exclude_none=True),
        }
        write_json(request.attempt_dir / "agent" / "request.json", input_payload)
        write_json(input_path, input_payload)

        runner_path = Path(__file__).with_name("pi_runner.mjs")
        process = await asyncio.create_subprocess_exec(
            "node",
            str(runner_path),
            str(input_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(Path(self.params.cwd).resolve()) if self.params.cwd else None,
        )
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            raise
        if process.returncode != 0:
            raise RuntimeError(stderr.decode(errors="replace")[-4000:])
        try:
            artifact = json.loads(stdout.decode())
        except ValueError as error:
            raise RuntimeError(f"Pi runner returned invalid JSON: {stdout.decode(errors='replace')[-1000:]}") from error

        write_json(output_path, artifact)
        _raise_for_provider_error(artifact)
        cost = self._cost_from_artifact(artifact)
        self.record_cost(request.attempt_dir, cost)
        result = HarnessResult(
            answer=str(artifact.get("final_response") or ""),
            provider=self.system_name,
            model=str(artifact.get("model") or self.params.model),
            response_id=str(artifact.get("session_id") or request.task_id),
            tool_calls=tuple(_tool_call_artifacts(artifact)),
            cost=cost,
            search_metrics=_search_metrics(artifact),
        )
        write_json(request.attempt_dir / "agent" / "result.json", result.to_dict())
        return result

    def _cost_from_artifact(self, artifact: dict[str, Any]) -> HarnessCost:
        usage = artifact.get("usage") if type(artifact.get("usage")) is dict else {}
        token_usage = TokenUsage(
            input_tokens=int(usage.get("input_tokens", 0) or 0),
            output_tokens=int(usage.get("output_tokens", 0) or 0),
            total_tokens=int(usage.get("total_tokens", 0) or 0),
            cached_input_tokens=int(usage.get("cached_input_tokens", 0) or 0),
            reasoning_tokens=int(usage.get("reasoning_tokens", 0) or 0),
        )
        cost = _openrouter_cost_from_artifact(artifact)
        return HarnessCost(
            currency="USD",
            usage=token_usage.to_dict(),
            usd={"openrouter_total_cost": cost} if cost is not None else {},
            cost_known=cost is not None,
        )


def _raise_for_provider_error(artifact: dict[str, Any]) -> None:
    messages = artifact.get("messages") if type(artifact.get("messages")) is list else []
    provider_errors = [
        str(message.get("errorMessage") or "")
        for message in messages
        if type(message) is dict and message.get("errorMessage")
    ]
    stop_errors = [
        str(message.get("stopReason") or "")
        for message in messages
        if type(message) is dict and message.get("stopReason") == "error"
    ]
    if not provider_errors and not stop_errors:
        return

    message = provider_errors[-1] if provider_errors else "provider returned stopReason=error"
    lowered = message.lower()
    if any(marker in lowered for marker in ("401", "403", "key limit", "api key", "unauthorized", "forbidden")):
        raise NonRetryableHarnessError(f"Pi provider request failed permanently: {message}")
    raise TerminalHarnessResponseError(f"Pi provider request failed: {message}")


def _tool_call_artifacts(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    counters = artifact.get("counters") if type(artifact.get("counters")) is dict else {}
    tool_calls = int(counters.get("tool_calls", 0) or 0)
    return [{"type": "pi_tool_call"} for _ in range(tool_calls)]


def _search_metrics(artifact: dict[str, Any]) -> dict[str, int | float]:
    counters = artifact.get("counters") if type(artifact.get("counters")) is dict else {}
    provider_citations = artifact.get("provider_citations")
    provider_responses = artifact.get("provider_responses") if type(artifact.get("provider_responses")) is list else []
    usage = _last_provider_usage(provider_responses)
    citation_metrics: dict[str, int | float] = {}
    if isinstance(provider_citations, list):
        citation_metrics = _citation_metrics(provider_citations)
    return {
        "tool_calls": int(counters.get("tool_calls", 0) or 0),
        "turns": int(counters.get("turns", 0) or 0),
        **citation_metrics,
        "web_search_requests": int_usage_value(
            nested_usage_value(usage, "server_tool_use_details", "web_search_requests")
            or nested_usage_value(usage, "server_tool_use", "web_search_requests")
        ),
        "web_fetch_requests": int_usage_value(
            nested_usage_value(usage, "server_tool_use_details", "web_fetch_requests")
            or nested_usage_value(usage, "server_tool_use", "web_fetch_requests")
        ),
        "server_tool_calls_executed": int_usage_value(
            nested_usage_value(usage, "server_tool_use_details", "tool_calls_executed")
        ),
        "server_tool_calls_requested": int_usage_value(
            nested_usage_value(usage, "server_tool_use_details", "tool_calls_requested")
        ),
    }


def _citation_metrics(provider_citations: list[Any]) -> dict[str, int | float]:
    citations = []
    for item in provider_citations:
        if type(item) is not dict or item.get("type") != "url_citation":
            continue
        citation = item.get("url_citation")
        if type(citation) is dict:
            citations.append(citation)
    content_lengths = [len(str(item.get("content") or "")) for item in citations]
    nonempty_content_lengths = [length for length in content_lengths if length > 0]
    urls = [str(item.get("url") or "") for item in citations if item.get("url")]
    titles = [str(item.get("title") or "") for item in citations if item.get("title")]
    return {
        "url_citations": len(citations),
        "citation_unique_urls": len(set(urls)),
        "citation_with_content": len(nonempty_content_lengths),
        "citation_content_chars_total": sum(content_lengths),
        "citation_content_chars_avg": _mean(content_lengths),
        "citation_content_chars_avg_nonempty": _mean(nonempty_content_lengths),
        "citation_content_chars_min": min(content_lengths) if content_lengths else 0,
        "citation_content_chars_max": max(content_lengths) if content_lengths else 0,
        "citation_url_chars_avg": _mean([len(url) for url in urls]),
        "citation_title_chars_avg": _mean([len(title) for title in titles]),
    }


def _mean(values: list[int]) -> float:
    return float(sum(values) / len(values)) if values else 0.0


def _openrouter_cost_from_artifact(artifact: dict[str, Any]) -> int | float | None:
    provider_responses = artifact.get("provider_responses") if type(artifact.get("provider_responses")) is list else []
    usage = _last_provider_usage(provider_responses)
    return openrouter_usage_cost(usage) if usage else None


def _last_provider_usage(provider_responses: list[Any]) -> dict[str, Any]:
    for response in reversed(provider_responses):
        if type(response) is not dict:
            continue
        usage = response.get("usage")
        if type(usage) is dict:
            return usage
    return {}
