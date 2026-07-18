from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from search_evals.config import load_systems
from search_evals.harnesses.registry import make_harness
from search_evals.io import read_json, write_json
from search_evals.runner import EvalRunner, _load_harness_result, _load_task_result
from search_evals.schemas import GraderResult, RunManifest, TaskDatum, TaskResult
from search_evals.suites.registry import make_suite


async def repair_run(run_dir: Path, *, concurrency: int, config: Path) -> dict[str, int | str]:
    manifest = RunManifest.from_raw(read_json(run_dir / "run_config.json"))
    systems = load_systems(config)
    system = systems.get(manifest.system.name, manifest.system)
    suite = make_suite(manifest.suite)
    runner = EvalRunner(
        system=system,
        suite=suite,
        harness=make_harness(system),
        runs_dir=run_dir.parent,
        concurrency=1,
        limit=None,
        run_suffix=manifest.run_suffix,
    )
    if runner.run_dir.resolve() != run_dir.resolve():
        raise ValueError(f"resolved run dir mismatch: {runner.run_dir} != {run_dir}")

    tasks = _load_persisted_tasks(run_dir)
    to_grade = _ungraded_tasks(run_dir)
    await suite.grader.preflight()
    suite.grader.hydrate_costs(run_dir)
    repaired = 0
    failed = 0
    semaphore = asyncio.Semaphore(concurrency)

    async def grade_one(task_dir: Path) -> None:
        nonlocal repaired, failed
        async with semaphore:
            task = tasks[task_dir.name]
            attempt_dir = _latest_attempt_with_agent_result(task_dir)
            if attempt_dir is None:
                return
            harness_result = _load_harness_result(attempt_dir / "agent" / "result.json")
            if harness_result is None:
                return
            try:
                grader_result = await _grade_with_retries(
                    suite.grader,
                    task,
                    harness_result.answer,
                    attempt_dir / "grader",
                )
            except Exception as error:
                failed += 1
                write_json(
                    attempt_dir / "grader" / "repair_error.json",
                    {"type": type(error).__name__, "message": str(error)},
                )
                return
            write_json(attempt_dir / "grader" / "result.json", grader_result.to_dict())
            suite.grader.record_cost(attempt_dir, grader_result.cost)
            result = TaskResult(
                task_id=task.id,
                score=grader_result.score,
                grade_type=grader_result.grade_type,
                metrics=grader_result.metrics,
                attempt_number=int(attempt_dir.name),
            )
            write_json(task_dir / "result.json", result.to_dict())
            write_json(attempt_dir / "attempt.json", {"attempt_number": int(attempt_dir.name), "status": "complete"})
            repaired += 1

    try:
        await asyncio.gather(*(grade_one(task_dir) for task_dir in to_grade))
        summary = runner._summary(list(tasks.values()))
        write_json(run_dir / "summary.json", summary)
        return {
            "run": run_dir.name,
            "suite": manifest.suite,
            "system": manifest.system.name,
            "found": len(to_grade),
            "repaired": repaired,
            "failed": failed,
            "remaining_ungraded": int(summary.get("ungraded_tasks", 0)),
            "agent_failed": int(summary.get("total_failed", 0)),
        }
    finally:
        await asyncio.gather(suite.grader.close(), runner.harness.close())


def _load_persisted_tasks(run_dir: Path) -> dict[str, TaskDatum]:
    tasks = {}
    for path in sorted((run_dir / "tasks").glob("*/task.json")):
        raw = read_json(path)
        task = TaskDatum(
            id=str(raw["id"]),
            problem=str(raw["problem"]),
            answer=str(raw["answer"]),
            metadata=dict(raw.get("metadata", {})),
        )
        tasks[path.parent.name] = task
    return tasks


def _ungraded_tasks(run_dir: Path) -> list[Path]:
    task_dirs = []
    for task_dir in sorted((run_dir / "tasks").glob("*")):
        if _load_task_result(task_dir / "result.json") is not None:
            continue
        if _latest_attempt_with_agent_result(task_dir) is None:
            continue
        if any((attempt / "grader" / "result.json").exists() for attempt in (task_dir / "attempts").glob("*")):
            continue
        task_dirs.append(task_dir)
    return task_dirs


def _latest_attempt_with_agent_result(task_dir: Path) -> Path | None:
    attempts = sorted((task_dir / "attempts").glob("*"), reverse=True)
    return next((attempt for attempt in attempts if (attempt / "agent" / "result.json").exists()), None)


async def _grade_with_retries(grader, task: TaskDatum, answer: str, trace_dir: Path) -> GraderResult:
    timeout = float(getattr(grader, "timeout_seconds", 45.0))
    last_error: Exception | None = None
    for _ in range(3):
        try:
            return await asyncio.wait_for(grader.grade(task, answer, trace_dir), timeout=timeout)
        except Exception as error:
            last_error = error
    assert last_error is not None
    raise last_error


async def repair_all(args: argparse.Namespace) -> None:
    for run_dir in args.run_dir:
        stats = await repair_run(run_dir, concurrency=args.concurrency, config=args.config)
        print(
            "\t".join(
                str(stats[key])
                for key in ("suite", "system", "found", "repaired", "failed", "remaining_ungraded", "agent_failed", "run")
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Grade tasks that have saved agent answers but missing grader results.")
    parser.add_argument("run_dir", type=Path, nargs="+")
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--config", type=Path, default=Path("systems.toml"))
    args = parser.parse_args()
    asyncio.run(repair_all(args))


if __name__ == "__main__":
    main()
