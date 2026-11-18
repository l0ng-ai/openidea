---
name: agent-prior-art
description: Survey how popular AI coding agents and IDEs (Cursor, OpenAI Codex, Claude Code, Cline, GitHub Copilot, VS Code Chat, JetBrains Air, Zed, OpenCode) design and implement a capability — reading open-source code, SDKs, protocol specs, design docs, and user/developer manuals — then critique what is good vs bad with verifiable links/citations and adapt only the best ideas to OpenIDEA. Use whenever creating an issue, reviewing/triaging an issue, planning/creating a PR, or reviewing a PR that involves features, UX flows, agent harnesses, skills, MCP, prompts, context, tools, or architecture.
---

# Agent & IDE Prior-Art Review: survey → critique → adapt

Before inventing a flow from scratch — or rubber-stamping a design in an issue or PR — check how leading AI coding agents and IDEs actually solve the same problem, verify their real behavior in source code or primary docs, judge the trade-offs critically, and borrow only the parts that fit OpenIDEA.

## 1. Scope gate (match depth to the task)

Do not run a heavy multi-agent research sweep on mechanical changes. Pick the right tier up front:

- **Skip (0 overhead):** Typos, dependency bumps, localized crash/null fixes, pure Rust/TypeScript compiler or linter cleanups with an obvious single fix.
- **Quick check (2–3 targeted lookups):** Contained UX tweaks, keyboard shortcuts, CLI flag alignment, error recovery, or edge-case behavior in an existing feature.
- **Full comparative survey (run in a `research` or `explore` subagent):**
  - Creating or reviewing a **feature issue** or RFC / design doc.
  - Planning, creating, or reviewing a **PR** that introduces or reshapes user-facing UX, agent sessions/composer, MCP/ACP/skills, context management, tool permissions, diff/apply flows, terminal execution, SDKs, or plugin extension points.

Running full surveys inside a subagent keeps raw search logs and large files out of the main task context.

## 2. Where and how to inspect prior art

Verify from primary sources — never rely on stale model memory alone. Prefer executable code and wire schemas over marketing pages.

### A. Open-source repositories & SDKs (read the code first)

Check sibling checkouts when present in a multi-repo workspace (for example `../cline`, `../copilot-cli`) before fetching remotely, then query upstream repositories via semantic code search or `gh`:

| Product / Ecosystem             | Primary Code, SDKs & Specs to Inspect                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI Codex**                | `openai/codex` (Rust CLI, `app-server` JSON-RPC protocol, sandboxing, skills, approvals), `@openai/codex-sdk`, `developers.openai.com/codex`                                                                                  |
| **Cline**                       | `cline/cline` (task loop, tool calling, checkpoints, MCP/skills UX, context truncation), `docs.cline.bot`                                                                                                                     |
| **GitHub Copilot & VS Code**    | `microsoft/vscode`, `microsoft/vscode-copilot-chat`, `github/copilot-sdk` (`@github/copilot-sdk`), `docs.github.com/en/copilot`                                                                                               |
| **Claude Code & Anthropic**     | `anthropics/claude-code` (issues/changelog/plugins), `@anthropic-ai/claude-agent-sdk`, `code.claude.com/docs`                                                                                                                 |
| **Cursor**                      | `cursor.com/docs`, `cursor.com/changelog` (Composer, Custom Modes, Rules/Skills, Context Ring, Background Agents, `agent-plugins.org`)                                                                                        |
| **Zed & ACP**                   | `zed-industries/zed` (Assistant panel, slash commands, worktrees), `agentclientprotocol/agent-client-protocol` (`@agentclientprotocol/sdk`)                                                                                   |
| **OpenCode / Continue / Aider** | `anomalyco/opencode`, `continuedev/continue`, `Aider-AI/aider` (repo map, edit formats, git hygiene)                                                                                                                          |
| **JetBrains Air & AI**          | `jetbrains.com/air` (`Air in IDEs`, `Air Gateway`, `Air Context`, `Air Teams`, Junie, ACP registry, inline diff comments, worktree sessions), `jetbrains.com/help/air`, `JetBrains/skills`, `jetbrains.com/help/ai-assistant` |
| **MCP**                         | `modelcontextprotocol/modelcontextprotocol` (`@modelcontextprotocol/sdk`, specs & transports)                                                                                                                                 |

### B. Evidence order for every agent surveyed

1. **Source code & tests** (if open-source): state machines, config schemas, edge-case tests, prompt/tool definitions.
2. **SDKs & wire protocols**: TypeScript/Rust types, JSON-RPC messages, CLI flags (`--help`, settings schemas).
3. **Design docs, RFCs, PRs & issues**: maintainer rationale, migration pain, and user-reported failure modes in GitHub Issues/Discussions.
4. **Developer & user manuals / changelogs**: UX workflows, defaults, keyboard shortcuts, and documented limitations.

## 3. Anti-clone rules (think critically, never copy blindly)

Popular agents ship plenty of expedient hacks and vendor-specific compromises. Treat external implementations as **input to critique**, not a spec to clone:

1. **Synthesize ideas; never copy code.** OpenIDEA is `Apache-2.0`. Study external repos (especially copyleft codebases such as GPL crates in Zed or Aider) strictly for architectural concepts, protocols, and UX trade-offs — write clean-room Rust/TypeScript native to OpenIDEA.
2. **Filter through OpenIDEA's architecture (`AGENTS.md`):**
   - **Multi-harness neutrality:** OpenIDEA orchestrates Copilot, Claude Code, Codex, Cursor, Gemini, and ACP side by side. Reject designs locked to one provider's private quirk when a portable abstraction works across all of them.
   - **Desktop + remote parity:** Every backend capability must respect `crates/ide-*` boundaries and work across both Tauri desktop and `openidea-server` (`IdeResult<T>`, non-blocking `spawn_blocking`/rayon, `CancellationToken`, UTF-16 coordinates).
   - **Git-clean workspace state:** Never mutate tracked repository files (for example rewriting `SKILL.md` frontmatter on disk just to toggle state) when `.openidea/settings.toml` or session state can hold overrides cleanly.
   - **Token & latency discipline:** Favor progressive disclosure, 0-token dormant scoping, and isolated subagents over dumping huge schemas into every turn.
   - **Visual & UI consistency:** Adapt interaction ideas to OpenIDEA's `src/styles/tokens.css`, `src/ui/` primitives, actions/keymaps, and `en.json` + `zh.json` text catalogs — never lift foreign visual chrome.
3. **Call out bad designs explicitly.** If a popular agent's approach is brittle, noisy, insecure, git-dirtying, or confusing, say so plainly, explain _why_ it fails, and do **not** clone it.

## 4. How to apply across Issue & PR workflows

- **Creating an issue / feature proposal:** Include a concise **Prior Art & Design Trade-offs** section summarizing how 2–4 relevant agents handle the problem, which ideas OpenIDEA should borrow, which anti-patterns to avoid, and links.
- **Reviewing / triaging an issue:** Check whether the request asks to clone a flawed competitor behavior (`needs-decision` when product trade-offs are nontrivial). Propose the cleaner cross-harness design backed by citations.
- **Creating / implementing a PR:** Survey before locking in data models, IPC commands, config formats, or UX flows. Keep the PR body itself concise per `CONTRIBUTING.md`, and share the detailed good/bad comparison + citations in the task summary or design discussion.
- **Reviewing a PR:** Benchmark the PR's UX, protocol handling, failure modes, permissions, and edge cases against established agents. Flag both missed best practices and accidentally imported anti-patterns, with exact reference links.

## 5. Required output rubric & citation rules

Whenever reporting findings (in chat, an issue, or a review), provide **opinions + verifiable links**:

1. **Comparison Snapshot:**
   | Agent / Tool | How It Works | What's Good (Borrow?) | What's Bad / Flawed (Avoid) | Reference |
   | ------------ | ------------ | --------------------- | --------------------------- | --------- |
2. **Recommended Design for OpenIDEA:**
   - **Borrow & Adapt:** Which specific mechanisms to adopt and how they map onto OpenIDEA's crates/features.
   - **Explicitly Reject:** Which competitor designs _not_ to copy and why.
3. **Verifiable Citations (mandatory):**
   - Every factual claim must link to its source: a GitHub permalink (`https://github.com/<org>/<repo>/blob/<sha-or-branch>/<path>#L<start>-L<end>`), issue/PR URL, npm/crate SDK file, or official doc URL.
   - If a behavior in a closed-source agent could only be inferred from docs/changelog rather than verified in code, label it as doc-verified rather than guessing internals.
