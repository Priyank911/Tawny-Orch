# Run monitor and stage-control plan

## Goal

Make an active Tawny Orch run understandable and controllable: show which stage is active, whether its local agent process actually started, what output it has produced, and what cancellation or stage skipping will do.

## What the reported run showed

The run `run-4f0fa2fd-decb-4d33-bb16-2512f2544a53` was persisted as cancelled. Research was the active OpenCode stage; the other five stages were queued because the engine only advances after a stage returns and passes its gates. The report exists and records that cancellation left no completed agent summary. The UI did not stream child-process output and offered stage skipping only after escalation, which made “Running” difficult to distinguish from a visible interactive terminal session.

## Implementation plan

1. **Observe the agent session:** stream bounded stdout/stderr lines from local headless child processes, redact secrets before forwarding or writing, record process start/PID/exit metadata, and write a per-attempt session log.
2. **Expose the task that was sent:** persist the Markdown task contract as a run artifact and let the user open the contract and session log from that stage. Opening is restricted to files inside the selected run directory.
3. **Allow intentional stage skips:** offer skip on queued, active, and escalated stages. An active stage receives a stop request before the engine advances. The UI and reports identify skipped work as unverified.
4. **Make cancellation terminal and legible:** request child process-tree termination, wait for the active collector/driver to drain up to a bounded limit, timestamp the interrupted stage, mark untouched stages cancelled, persist the run, and write the final report before returning to the UI.
5. **Verify behavior:** cover output callbacks, active-stage skip and continuation, cancellation state, end timestamps, queued-stage disposition, and report contents; run typecheck/build and the relevant integration tests.

## Boundaries

- Selected agents run as headless local child processes. The app can show their captured output and open the saved session log; it cannot attach to or control an interactive TUI after that process has started.
- A skipped stage is not a successful or verified stage. Later stages continue with a recorded gap in the pipeline.
- Cancellation requests process-tree termination and waits for the engine to drain within a bounded window. If a tool cannot stop within that window, its session log and failure state must make the uncertainty visible.
- The output view is a bounded tail, and output is redacted before display or persistence. A tool's output is untrusted text, not UI markup or instructions to the orchestrator.

## UI direction

Keep the existing porcelain, slate, cobalt and teal system and the sequential handoff rail. Add a compact session panel inside each stage: process state and PID, working directory, recent stdout/stderr, and actions for opening the contract or log. This keeps the pipeline as the overview and makes session evidence available at the stage where the decision is made.
