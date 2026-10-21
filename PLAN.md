# Tawny Orch — Agentic Orchestration Harness for Windows

> Implementation note (October 2026): this file began as a target plan and some catalog entries below have since changed. Antigravity CLI (`agy`) now has a headless adapter; Muse Code remains a manual packet slot. Read the root README's implementation status for the current repo audit. This plan is not a claim that every listed subsystem is complete.

Version 1.0 | Fork of Tawny's voice-first pipeline, re-aimed at orchestrating
heterogeneous coding agent terminals (Claude Code, Codex, Gemini CLI, Cursor,
OpenCode, Antigravity, Muse Code, Manual slots) as a background dev pipeline.

---

## 1. What this is

A private, keyboard-first orchestration layer for Windows built exactly like Tawny:
one global shortcut opens a compact voice pill, you say the goal, attach a project
folder, and the whole dev pipeline runs in the background. Agents are ordinary
terminals the user installs once — the harness detects them, routes stages to them,
keeps them in sync through a shared memory store and structured handoffs, and
gates every handoff deterministically.

```
Ctrl + Alt + Space            (same hotkey as Tawny)
        │
     arming → recording → finalizing → transcribing (Groq Whisper)
        │
     gating → deciding  (voice → run intent: goal, pipeline,folders)
        │
     confirming               — one look, then hands off
        ▼
   ORCHESTRATION ENGINE (background)
   INTAKE → RESEARCH → PLAN → EXECUTE → TEST → REVIEW → DELIVER
      gate       gate      gate     gate     gate     gate
        │ each stage: dispatch contract → agent terminal runs headless
        │             artifacts collected → deterministic gates → pass/fail
        ▼
   SHARED MEMORY + EVENT LEDGER appended after every successful gate
        │
     done (overlay shows stage timeline live)
```

### Differences from Tawny (voice router)

| | Tawny | Tawny Orch |
|---|---|---|
| Output | paste text/image into focused app | drive agent terminals through a pipeline |
| Providers | Groq Whisper + Cloudflare CLEF/Flux | Groq Whisper + installed agent CLIs |
| State machine | voice capture lifecycle | voice capture lifecycle **+ full DAG run engine** |
| Shared state | none | memory ledger shared by all agents |

### Differences from cloud orchestrators (Orca etc.)

- No IDE to babysit — one hotkey, speak, everything runs behind the overlay.
- The user owns the flow: every stage's agent assignment is editable, pinnable, reorderable.
- Runs on the user's machine against the user's terminals; no account, no cloud control plane.
- Voice is a first-class control surface, not a bolt-on.

---

## 2. Design principles (inherited from Tawny + the multi-agent architecture doc)

1. Deterministic control plane. The engine owns the flow; agents never decide it.
2. Agents are stateless workers. Everything arrives as a typed task contract, leaves as typed artifacts.
3. Git is the handoff medium. Code moves as branches; prose moves as artifacts in the run dir.
4. Gates are code. Zod schema checks, secret scans, scope diffs, and acceptance commands decide pass/fail.
5. Independent verification. Test/review stages are never routed to the agent family that authored the code.
6. Every boundary emits a structured, append-only event.
7. Humans own irreversible actions. A stage that cannot pass after its retries escalates and pauses.
8. Never lose the user's input. A failed run keeps every artifact and the exact contract that failed.

---

## 3. Agent make/lineup and tiering

Detected by probing PATH and known install locations, then `--version` (8 s cap).
Not detected? Shown as "Not installed" with the exact one-line install hint.

| Agent | Mode | Tier | Headless invocation | Role bias |
|---|---|---|---|---|
| Claude Code | CLI | A | `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions --max-turns N` | plan, execute, review |
| Codex (OpenAI) | CLI | A | `codex exec --json --full-auto "<prompt>"` | parallel execute, tests |
| Gemini CLI | CLI | A | `gemini -p "<prompt>" --yolo` | research, execute |
| Cursor Agent | CLI | B | `cursor-agent -p "<prompt>"` | execute, refactor |
| OpenCode | CLI | B | `opencode run "<prompt>"` | execute |
| Antigravity CLI (`agy`) | headless CLI | A | `agy -p "<prompt>" --output-format stream-json` | research, plan, execute, test, review |
| Muse Code | manual packet | C | task packet plus result sentinel | human-in-the-loop slot |
| Manual | manual packet | C | generic escape hatch for any tool | pipeline never blocked |

Tier semantics:
- **A**: full adapter — headless, streaming stdout, cancelable, structured result parse.
- **B**: limited adapter — headless but plain stdout capture; artifacts verified by gates rather than trust.
- **C**: manual slot — contract packet + result sentinel; gates still verify anything ingested.

All A/B agents run through **one** child-runner: spawn, stream stdout/stderr, arena of
JSON-line parsers per vendor, timers, kill-on-cancel, artifact capture.
Quirks live behind the adapter interface only.

---

## 4. Architecture (Tawny's house style)

```
src/
├── shared/
│   └── contracts.ts          Zod schemas + PipelineError + orphan event types
├── main/
│   ├── app.ts                lifecycle, tray, hotspot hotkey, two-window shell, IPC wiring
│   ├── index.ts              electron-vite main entry
│   ├── logger.ts             structured JSONL logger (%APPDATA%)
│   ├── settings.ts           safeStorage-encrypted credentials
│   ├── preload.ts            contextBridge surface only
│   ├── detect/
│   │   └── registry.ts       agent catalog + detection probes + install hints
│   ├── agents/
│   │   ├── base.ts           AgentAdapter protocol, TaskContract, ArtifactBundle
│   │   ├── childRunner.ts    generic spawn runner: stream, timeout, kill, JSONL parse
│   │   ├── claudeCode.ts     Tier A
│   │   ├── codex.ts          Tier A
│   │   ├── gemini.ts         Tier A
│   │   ├── cursorAgent.ts    Tier B
│   │   ├── opencode.ts       Tier B
│   │   ├── antigravity.ts    Tier A headless CLI
│   │   ├── museCode.ts       Tier C packet
│   │   ├── manual.ts         Tier C packet
│   │   └── index.ts          adapter registry
│   ├── orchestrator/
│   │   ├── templates.ts      default pipelines (solo, duo, cross-vendor)
│   │   ├── router.ts         capability + score routing with family independence rule
│   │   ├── prompts.ts        contract → prompt builder (STRICT mode output contract)
│   │   ├── worktree.ts       git worktree per execute/test attempt
│   │   ├── gates.ts          schema / secret-scan / scope-diff / acceptance-command gates
│   │   ├── memory.ts         shared memory ledger (conventions, decisions, failures, interfaces)
│   │   ├── events.ts         append-only event ledger + live fan-out
│   │   ├── store.ts          run persistence (state.json per run)
│   │   └── engine.ts         DAG scheduler, retry ladder, escalation, cancels
│   ├── pipeline/
│   │   ├── machine.ts        XState voice lifecycle (Tawny parity)
│   │   └── voice.ts          voice grammar: wake phrase, intents, slot extraction
│   └── providers/
│       └── groqWhisper.ts    Whisper-large-v3-turbo with segment rotation
└── renderer/                 Tawny visual system: glassy white pills, slate text, green accent
    ├── index.html
    ├── main.tsx              shell: Agents / Pipeline / Runs / Settings + voice overlay
    └── styles.css            Tawny palette port by extension
```

### Process boundaries

| Boundary | Responsibility |
|---|---|
| Renderer → preload | mic capture, UI intents, voice events |
| Main → detect | PATH probes, version checks |
| Main → agents | child spawns, stream parse, worktrees |
| Main → providers | Groq HTTPS transcription |
| Main → renderer | snapshots, run events, log entries |

contextIsolation stays on; Node is never exposed to the renderer.

---

## 5. The run engine

### Stage states

```
QUEUED → ROUTED → CONTRACT_READY → RUNNING → GATED → (PASSED | FAILED)
FAILED → RETRYING (≤2 re-dispatches with failure context; then ESCALATED)
PASSED → artifacts committed to run dir → memory written → next stage
RUN -> CANCELLED at any point; ESCALATED pauses for human decision
```

### Retry ladder (per architecture doc §9)

attempt 1 primary agent → attempt 2 same agent + failure context → attempt 3
router-recommended fallback → ESCALATED (paused; user reassigns or cancels via UI).

### Default pipelines

1. **Solo** — plan and execute by one agent, test/review by another (if present).
2. **Duo** — Plan+Execute on family A; Research, Test, Review split cross-family.
3. **Cross-vendor** — Research (gemini), Plan (claude), Execute (codex), Test (gemini),
   Review (claude), Deliver (pinned family other than author).

Pinning any stage in the UI overrides the router for that stage.

### Router scoring (from §6 of the architecture doc)

```
score(agent, stage) =
    0.55 * priorPassRate(agent, role)        # hand-set priors, learns from runs
  + 0.15 * (1 - normalizedExpectedCost)      # static cost class per agent
  + 0.15 * (1 - normalizedExpectedLatency)   # static speed class per agent
  - 0.10 * currentLoad(agent)                # 0..1 concurrent running contracts
  - 0.30 * sameFamilyPenalty(test/review)    # family that authored cannot verify
```
Priors live in `agent_scores.json`, updated by the engine after every stage close.

---

## 6. Memory (shared across agents)

`memory.jsonl` in the project's `.tawny-orch/` directory:

| Category | written when | example |
|---|---|---|
| Conventions | after plan pass | file layout, naming, test commands |
| Decisions | after plan/execute pass | "paused routes table" with reason |
| Failures | whenever a gate failed | root cause + what fixed it |
| Interfaces | after execute pass | stable endpoints, types |

Every entry: `{id, category, content, sourceRunId, sourceStage, confidence, createdAt}`.
Owners: only the engine writes; next stage's contracts embed the top entries as context.

---

## 7. Handoff contract and result

Every stage boundary ships this packet to the agent (and to Tier C packets as markdown):

```json
{
  "runId": "run-…", "stageId": "execute", "role": "execute", "agentId": "codex",
  "goal": "…", "projectPath": "…", "worktreePath": "…", "baseBranch": "main",
  "planSummary": "…", "researchSummary": "…", "diffSoFar": ["…"],
  "memory": [{ "category": "decisions", "content": "…" }],
  "constraints": { "allowedFiles": ["src/**"], "forbiddenFiles": [".env*"],
                   "timeoutMinutes": 15, "acceptanceCommands": ["pnpm test"] },
  "previousFailure": { "gate": "secret_scan", "reason": "…" },
  "strictOutputContract": { "path": ".tawny-orch/runs/run-…/result.json",
    "fields": ["status","summary","filesChanged","assumptions","unresolved","confidence"] }
}
```

Agents that honor the strict contract write `result.json` (Tier A/B adapters parse
streamed final results too); everything is verified by gates. Malformed output counts
as a failed attempt, never a crash.

---

## 8. Gates

| Gate | Runs | Behavior |
|---|---|---|
| result_schema | Zod validate `result.json` | fail → malformed attempt |
| secret_scan | regex corpus over diff + artifacts | any hit = fail, blocked handoff |
| scope | `git diff --name-only` vs allowedFiles | writes outside scope = fail |
| acceptance | user-configured commands (`pnpm test`…) | exit-tagged pass/fail, 5 min cap |
| infra errors | spawner-level | re-run gate, does not count against the agent |

Gates run in a clean cwd (the worktree root), never through the agent.

---

## 9. Voice grammar (Tawny gate + intent hand-me-down)

- **Wake phrase**: "hey tawny"/"hey buddy" (fuzzy, edit distance ≤ 2) or `always route` mode.
- **Intents** (deciding stage):
  - `build_in_project`: "build/run/… <goal> in <folder>" or after attach
  - `new_project`: "create a new project called X in <path>"
  - `attach_folder`: "attach/open/use folder D:\…" (drive-slash extractor)
  - `status`: "what's the status of the run/pipeline"
  - `stop / cancel / pause / resume`
  - `assign`: "assign research/team planning to gemini" (guardrail: agent must be detected)
- Otherwise — dictation is treated as the goal for the attached project (Tawny's
  "keep uncertainty on the safe side" rule, flipped: default action is build).

---

## 10. Settings

sameStorage-encrypted as Tawny: Groq API key (Whisper), Cloudflare account ID/token
(image generation passthrough keeps Tawny capability parity; optional in Orch).
Agent CLI versions are not stored; they are probed live.

---

## 11. Test plan — DONE (P0)

Vitest (`pnpm test`, same runner): voice grammar slots, wake phrase + utility-intent
routing, stage templates, gate coprocessors (secrets/scope globs), router scoring
matrices + independent verification, contract builder round-trips, vendor output
parsers + catalog coverage, and the engine end-to-end with real manual packet
adapters (packet → DONE.json sentinel → memory ledger → cancel).

Current status: `pnpm typecheck` green, 54/54 tests green, `pnpm build` green,
app boots with the `Control+Alt+Space` hotkey registered.

Files: `test/voice.spec.ts`, `test/gates.spec.ts`, `test/contract.spec.ts`,
`test/router.spec.ts`, `test/detect.spec.ts`, `test/engine.spec.ts`.

---

## 12. Roadmap

| Phase | Contents | Exit |
|---|---|---|
| P0 (this build) | full app above, Tier A/B/C adapters, 3 pipelines, voice | typecheck green, tests green, build green |
| P1 | live diff viewer, acceptance presets, branch merge polish | run produces PR-style summary |
| P2 | benchmark suite per project type, learned router weights | measurable pass rates |
| P3 | multi-project backlog, tray notifications, autoupdaters | background-only usage painless |
