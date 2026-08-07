# AGENTS.md — CharaMate Greenfield

This file governs the new CharaMate implementation. It assumes this file and the three design documents below live together at the repository root. The project is greenfield: do not inherit old product behavior, old schemas, compatibility layers, or historical implementation choices unless the user explicitly adds them to the new product.

## Read first

Read these documents completely before designing or changing code:

1. [`REFACTOR_PRODUCT_DESIGN.md`](./REFACTOR_PRODUCT_DESIGN.md) — product scope, behavior, runtime contracts, data and process architecture.
2. [`CHARA_MATE_UI_DESIGN.md`](./CHARA_MATE_UI_DESIGN.md) — visual language, Chats/Composer/Run/Voice interactions and usability acceptance.
3. [`refactor-architecture-decisions-2026-07-31.md`](./refactor-architecture-decisions-2026-07-31.md) — prospective research protocols, candidate Arms, metrics and decision gates.
4. [`docs/progress/STATUS.md`](./docs/progress/STATUS.md) — current milestone, active work packages, blockers and last green verification.
5. [`docs/progress/ROADMAP.md`](./docs/progress/ROADMAP.md) — Phase 0–7 DAG, work-package boundaries and milestone acceptance.

Authority order is: current user request → product design → UI design → accepted benchmark Decision Record → research design. STATUS and ROADMAP track execution of those authorities; they do not override product behavior or an accepted Decision. The research document defines how to choose; it never defines a production default. If documents conflict, stop implementation at the conflict and update the authoritative document instead of supporting both interpretations.

## Commands

```text
npm run check:fast        # L0 static + contract fast check
npm run test:focused      # affected unit and component tests
npm run test:integration  # domain and boundary integration tests
npm run verify:offline    # complete deterministic offline verification
npm run build             # Main/Preload/Renderer production build
npm run package           # Electron Forge package
npm run test:e2e          # Playwright Electron E2E
npm run verify:phase0     # complete Phase 0 acceptance chain
npm run test:live         # explicit live suite (not part of offline regression)
npm run test:benchmark    # explicit benchmark suite (not part of offline regression)
```

## Non-negotiable product rules

- Text Chat, voice, automations and proactive conversations share one Run/Item runtime.
- Chat versus Agent and the execution approval level are explicit Composer choices.
- Production has one implementation for each internal concern. Experimental alternatives never become runtime modes, fallback chains, Settings choices or compatibility branches.
- The normal product UI contains no Harness tuning, retrieval parameters, benchmark controls or developer metrics.
- Provider credentials use the documented secret store; detected secrets are removed at persistence and logging boundaries. Agent execution uses the three documented approval modes. Do not expand these into a general security product.
- No arbitrary relationship levels, intimacy score, game economy or unrelated feature system.
- Do not add old-product migrations or legacy adapters to a greenfield database. Add migrations only after real released data creates that requirement.

## Selected foundation stack

The user has selected one foundation stack for the greenfield implementation. Treat these as production constraints, not experiment Arms:

- one npm package with an exact lockfile; do not create a monorepo or maintain a second package-manager path;
- Electron + Electron Forge + the pinned Forge Vite Plugin as the only desktop build/package path;
- strict TypeScript and ESM across Main, Preload, Renderer and shared contracts;
- ESLint flat config with typescript-eslint/React Hooks plus Prettier as the only lint/format path;
- React with CSS Modules and CSS Custom Properties; use Radix Primitives for headless interaction, Lucide for the common SVG icon set and TanStack Virtual for long lists;
- `react-markdown`/remark/rehype, KaTeX, lazy Shiki and lazy Mermaid for message content; PixiJS for the pet and Territory sprite renderer;
- TypeBox + Ajv as the JSON Schema-first source for Tool, IPC, event and persistence-boundary validation;
- narrow typed `contextBridge` APIs. Never expose raw `ipcRenderer` to the Renderer;
- `better-sqlite3`, prepared SQL and domain-owned repositories without an ORM. Journal, checkpoint, batching, vector layout and workers remain Decision-gated;
- a CharaMate-owned event-driven Agent Harness. Do not introduce a general orchestration framework such as LangChain or LangGraph; official Provider SDKs may exist only inside adapters;
- the official OpenAI JavaScript SDK inside OpenAI/Azure HTTP adapters and the official MCP TypeScript SDK at the MCP boundary; neither owns CharaMate Run state;
- `playwright-core` with a product-managed Chromium for Browser capability; Playwright Electron for desktop E2E;
- async Electron `safeStorage` plus the shared redaction boundary for credentials;
- Pino plus typed local events/metrics for observability; do not preinstall an external telemetry platform;
- Vitest and Testing Library for deterministic unit/component/integration tests, with live and benchmark suites kept out of the default regression.

Electron Forge's Vite Plugin is currently documented as experimental. Phase 0 must pin the exact compatible versions and pass development launch, native `better-sqlite3`, package, packaged-app smoke and Playwright Electron checks before this build path is frozen. If it fails, stop and update the authoritative design before selecting a different single path; never retain two build pipelines.

Do not turn Decision-gated choices into foundation-stack defaults. Retrieval models, fusion, reranking, ANN, graph, SQLite tuning, Context Recipe, Voice architecture/transport/join, multi-agent, self-evolution and numeric thresholds still require their named Decision Records.

## Source-first design gate

Before fixing any lifecycle, resource or protocol behavior, inspect current primary sources and record the source version/date in the relevant design or benchmark record.

This gate applies especially to:

- model-step limits, Run stop conditions, context compaction and continuation;
- Tool/Skill/MCP schemas and discovery;
- concurrency, sub-agent dispatch and result joining;
- Realtime events, authentication, media transport, VAD and interruption;
- database journal/checkpoint behavior, retention, topK and other numeric thresholds.

Separate three things explicitly:

1. a protocol hard limit from official documentation;
2. current behavior observed in authoritative source code;
3. a CharaMate heuristic.

Only the first is automatically a constraint. The second is a sourced candidate. The third requires an experiment or usability test. Never invent a fixed “12 steps”, wall-clock Run kill, token/cost kill, concurrency count, context percentage, TTL, batch size or topK and present it as SOTA.

Except for an official protocol hard limit, a correctness or irreversible-side-effect red line, or a threshold the user explicitly marks non-negotiable, a preregistered numeric gate is decision evidence rather than an automatic veto. Never discard an otherwise clearly better option solely because one confidence bound narrowly crosses a CharaMate heuristic. Report the point estimate, interval, effect size, quality, cost, scale, latency and complexity together. If the mechanical preregistered outcome conflicts with that overall evidence, preserve it and record any different product selection as a transparent post-result tradeoff amendment.

When using Codex as a reference, inspect the current public source/manual rather than copying a remembered design. Record the commit or documentation version used.

## Experiment-to-production lifecycle

Candidate Arms belong only to disposable experiment work. For every unresolved internal choice:

1. Assign a stable Decision ID and preregister the question, primary-source versions, dataset hash, hardware/model, Arms, single changed variable, metrics and promotion gates.
2. Implement candidate-specific code in a disposable branch or worktree, outside the production runtime path.
3. Run paired or otherwise fair comparisons and preserve non-sensitive evidence.
4. Write a Chinese decision record at `docs/benchmarks/<decision-id>.md` containing the question, sources, environment, results with denominators/intervals, failures, complexity cost, winner, rejected alternatives and what the experiment cannot claim.
5. Reimplement or simplify the winner as the single clean production path. Do not merely flip an experiment flag to make one Arm the default.
6. Before merge, delete losing Arms, adapters, flags, temporary schemas/migrations, candidate-only dependencies, model packages, scripts and Settings controls.
7. Run a single-path audit and the required regression layers.

Archive raw result files outside the repository by hash or delete them. The final repository keeps one Chinese Decision Record per decision; compact aggregates and reproducibility identifiers live inside that Markdown. Delete experiment runners and candidate-specific assets before production merge. A small sample may survive only after it is rewritten and owned as a regression fixture for the winning production path; the Decision Record must explain that role, and the fixture must carry no Arm switch or candidate identity.

If Arms are statistically indistinguishable, choose the simplest baseline. Do not keep both “just in case”.

## Compatibility boundary

“One production path” does not prohibit product-required external interoperability. The following may have bounded adapters because they are user-facing requirements:

- OpenAI-compatible and Azure Provider protocols;
- standard MCP transports and Agent Skills format;
- Codex-compatible pet import formats explicitly named by the product;
- operating-system-specific platform adapters;
- DOM/App Action/Computer Use capability routing required to operate different targets.

Keep those differences at the adapter boundary and expose one domain contract. They must not fork Chat, Run, Memory or UI state machines. Experimental algorithms, old database layouts and speculative provider fallbacks are not interoperability and must not be retained.

## Security scope

Security/privacy design is intentionally limited to:

1. detecting and removing credentials or equivalent secrets before persistence, plus simple platform-backed secret storage;
2. the documented user approval flow for executable Agent actions.

OS permission prompts required for Accessibility, screen capture or microphone access are platform prerequisites, not a new CharaMate permission framework.

Unless the user explicitly expands scope, do not add threat-model frameworks, adversarial prompt systems, sandbox matrices, trust scores, policy DSLs, enterprise RBAC, compliance/audit exports, multiple privacy modes or security-tuning screens. Schema validation, cancellation, idempotency, evidence links, crash recovery and generation checks are correctness mechanisms; describe and implement them as such.

Apply the same proportionality rule to engineering and research work. Treat ordinary product experiments as ordinary experiments: do not add adversarial audits, pair-unlinkability tests, encrypted oracles, cryptographic commitments, tamper-evident evidence chains or security-style red-team matrices merely to make the protocol look stronger. Use the minimum controls needed for reproducibility and honest comparison—normally versioned inputs, stable IDs/seeds, hashes, independent labels, blinded holdout use and preserved raw evidence. Add stronger security or adversarial controls only when the user asks for them or a concrete in-scope risk such as real secrets, private data or irreversible external effects requires them.

## Target repository structure

Create directories only when their first real owner exists. The intended shape is:

```text
/
  AGENTS.md
  REFACTOR_PRODUCT_DESIGN.md
  CHARA_MATE_UI_DESIGN.md
  refactor-architecture-decisions-2026-07-31.md
  docs/
    progress/
      STATUS.md
      ROADMAP.md
    benchmarks/
  src/
    shared/
      contracts/
      schemas/
      pure/
    main/
      app/
      chat/
      agent/
      approval/
      tools/
      memory/
      activity/
      voice/
      territory/
      automations/
      providers/
      observability/
      db/
    preload/
    renderer/
      app/
      features/
      components/
  tests/
    contract/
    integration/
    e2e/
    fixtures/
```

`docs/benchmarks/` contains Chinese decisions, not executable candidate implementations. Do not create a permanent experiment-code area, empty domain folders, generic “core/common/utils” dumping grounds or a monorepo without a measured need.

Colocate focused unit tests with the module they exercise; reserve root `tests/` for contracts, cross-domain integration, Electron E2E and shared fixtures.

Keep this root file as the default instruction surface. Add a nested `AGENTS.md` only when one domain has genuinely different commands or invariants; keep it short, let it override only that subtree and do not duplicate root rules.

## Ownership and dependency rules

- Each domain owns its tables, repository, service, events and focused tests.
- Other domains use typed public contracts; they do not read another domain's tables directly.
- Renderer → typed preload contract → Main domain service is the desktop boundary.
- `shared` contains stable contracts, schemas and pure logic only. It does not become a business-logic landfill.
- Memory does not depend on Territory. Territory references Memory IDs and consumes published Memory events.
- Activity proposes digests/memories; it does not directly mutate Persona or scenes.
- Voice is a Model/transport driver for the same Agent Runtime, not a second Harness.
- Provider and platform-specific behavior stays behind adapters.
- Every change to shared contracts, IPC, database schema or cross-domain events names exactly one integration owner for that change; unrelated domains can keep moving in parallel.

Avoid a God service. Also avoid one interface per function: a domain normally exposes one service contract and a small number of pure modules.

## Work packages and parallel delivery

Every implementation task must be a bounded work package with:

- outcome and linked product/UI sections;
- in-scope files/domain and explicit non-goals;
- dependencies and the contracts it consumes or changes;
- acceptance criteria;
- focused tests, required integration tests and user-visible verification;
- Decision IDs still blocking implementation;
- candidate-code deletion plan when experimental.

Parallelize only work with disjoint ownership or read-heavy investigation. Never have two workers concurrently edit the same source files, shared contract, schema migration or mutable Browser profile. Use separate branches/worktrees for independent write-heavy packages; integrate through the designated owner.

A practical dependency order is summarized below; the complete Phase 0–7 DAG, work packages and exit criteria live in `docs/progress/ROADMAP.md`:

```text
toolchain compatibility + foundation contracts + Run/Item schema
  ├─ UI shell/Chats using frozen fixtures
  ├─ persistence/IPC event replay
  ├─ Provider/Model/Secret adapters
  └─ HARNESS-LOOP + TOOL-DISCOVERY experiments
       └─ single Agent Runtime + Tool/Approval path
            ├─ Memory decisions → Memory → Activity decisions → Activity
            ├─ Voice decisions → one Realtime implementation
            ├─ Reminder/Agent Task
            ├─ MULTI-AGENT decision → optional collaboration
            └─ pet foundation
                 └─ stable Memory/Activity + Image adapter → Territory
```

Phase numbers are integration and acceptance order, not a global lock. After the Agent path is stable, Memory research, Voice contract work, Automation foundation, pet foundation and isolated Multi-agent experiments may proceed in parallel. After Memory is stable, Activity, proactive chat, Territory memory items and isolated self-evolution experiments may proceed in parallel. Shared-contract and schema changes remain serialized.

Do not choose an arbitrary maximum team size. Parallelism is bounded by independent ownership, available test capacity and the integration owner's ability to review. Shared-contract and schema changes are serialized. A subtask returns a concise evidence summary and changed-file list, not a raw activity transcript.

## Progress management

`docs/progress/STATUS.md` is the short current-state source of truth. Keep only:

- current milestone and exit criteria;
- active work packages, owner and status;
- dependency/blocker and pending Decision IDs;
- last green verification commands, date and durations;
- known product-impacting issues.

Use statuses: `specified → contract-ready → implementing → focused-verified → integration-verified → done`.

`docs/progress/ROADMAP.md` records milestone dependencies and acceptance, not a giant append-only task history. Archive completed milestone detail instead of growing an eternal Done log. Update STATUS at package start, handoff and completion—not after every command.

“Done” means product acceptance is met, docs/contracts are current, required tests pass, losing experiment paths are gone and no hidden compatibility branch remains.

## Test architecture and cadence

Keep default regression deterministic, offline and layered:

Once the scaffold exists, add a short `Commands` block near the top of this file that names the actual package scripts for fast check, focused/domain tests, full offline verification, build and live tests. Keep one canonical command per purpose and update it with the scripts; do not guess commands before they exist.

| Layer | Purpose | When to run |
| --- | --- | --- |
| L0 static/contract | typecheck, lint/format, schema/IPC contract checks | continuously for affected code |
| L1 focused unit | pure domain logic and reducers | during implementation |
| L2 domain integration | SQLite, IPC, Run/Tool/Memory/Voice boundaries | before work-package handoff |
| L3 desktop E2E | critical user journeys across Electron windows/processes | before milestone/merge when impacted |
| L4 live/benchmark | real Provider, Realtime, image, Computer Use and research gates | explicitly, never in default regression |

During editing, run the narrowest affected tests. Before handoff, run the domain suite plus affected contracts and typecheck. Before merge or milestone completion, run the full offline suite, build and the relevant E2E/package checks. Run live endpoints only when the feature or Decision Record requires them, and report those results separately from offline tests.

Use fake clocks, deterministic fixtures and injected adapters. Do not use arbitrary sleeps or real network/model calls in default tests. Shard by domain when the suite grows, record slow suites in STATUS, and fix accidental test slowness instead of making every change pay for the entire live matrix. A skipped/quarantined test needs an owner, reason and removal condition.

Shared contract, IPC or schema changes require all dependent integration suites. A local renderer style change does not require unrelated storage benchmarks; a Memory schema change does.

## Complexity budget

Before adding a module, process, table, background job, dependency, setting, feature flag or persistent state, answer:

1. Which product requirement owns it?
2. Why can the existing domain not own it?
3. What is its lifecycle and failure behavior?
4. Which tests and maintainer own it?
5. When can it be deleted?

Reject wrapper-only abstractions, duplicated state, speculative fallback providers, internal algorithm settings, candidate compatibility layers and modules created only for a possible future feature. Quality-equivalent designs choose fewer processes, states, tables and dependencies.

## Documentation rules

- Product design describes the one intended product behavior and stable contracts, never experiment Arms.
- UI design describes the selected interaction and prototype tokens; after usability testing, replace rejected values rather than retaining themes/layout branches.
- Research design contains prospective protocols and candidates, never historical project results or claims that an Arm already won.
- Completed experiment decisions are Chinese Markdown under `docs/benchmarks/` and include evidence, limitations and deletion proof.
- Use stable IDs/hashes instead of absolute workspace links. External references should point to primary sources.
- Developer metrics belong in the local Dev Dashboard and logs, not ordinary product screens.

## Git and completion

- Inspect the working tree first and preserve unrelated user changes.
- Commit normal project progress directly to `main` unless the user explicitly requests another branch. Commit or push only when the user asks.
- Use a Conventional Commits subject in the form `<type>: <concise human-readable progress>`, such as `docs: 完善分阶段实施规划`. Choose the type that matches the change, and never use internal work-package, Decision or milestone IDs as the subject or as a substitute for the progress description.
- The repository owner authors commits. Never add AI/Claude/Codex co-author trailers.
- Before handoff, inspect the diff, run whitespace/format checks, list validations actually run and state anything not run.
- Never call a design “SOTA” solely because it resembles another project; cite the current source and/or provide CharaMate benchmark evidence.

Workflow references: [Codex AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md), [long-running work](https://learn.chatgpt.com/docs/long-running-work.md), and [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md).
