---
name: omp-impeccable-upstream-sync-audit
description: "Use when the omp-impeccable fork breaks after upstream Impeccable changes, or to audit it against upstream skill features."
---

# omp-impeccable upstream sync audit

Repo: `Sylonin/omp-impeccable` (standalone, detached from `jenkei/omp-impeccable`) at `~/Proj/p/omp-impeccable`, linked into omp with `omp plugin link`. Run pnpm through a corepack shim: `mkdir -p /tmp/pnpm-shim && corepack enable --install-directory /tmp/pnpm-shim pnpm`, then `PATH=/tmp/pnpm-shim:$PATH pnpm release:check`.

## 1. Find what upstream changed
- Commits since the last sync: a blob-filtered clone (`git clone --filter=blob:none https://github.com/pbakaus/impeccable`) and `git diff cli-v<old> cli-v<new> -- .omp .claude/agents skill/agents skill/SKILL.src.md skill/reference/{live,hooks,doctor}.md crates/hook crates/live crates/context docs/HARNESSES.md`. Releases are tagged `cli-v*`, `skill-v*` and `engine-v*`; the npm version is the `cli-v` tag.
- Upstream has its own `omp` provider (4.6+, PR #900): skill only. `docs/HARNESSES.md` lists no OMP hook and no OMP subagents, and OMP skips `.claude/agents`. Re-check that row and the `omp` entry in `scripts/lib/transformers/providers.js` first: if upstream ever ships OMP hooks, subagents or a background live loop, decide whether this plugin is still needed.
- Compare against `.omp/skills/impeccable/SKILL.md`: the routing rules, the command table (`grep -oE '^\| \`[a-z-]+'`), and the bold Pin, Hooks, Doctor and Foundations lines; a new bold route needs an `agentCommands` entry and a fallback description.
- Live protocol: `EVENT_TYPES_NEEDING_AGENT_REPLY` in `crates/live/src/live_poll.rs` must match `agentReplyEvents`; check `live-complete` and `live-poll --reply` flags, and the boot command and output fields in `reference/live.md` `## Start` (4.10: `live --allow-missing-context --dev-url --auto-config [--target <path>]`, built by `boot_instructions` in `crates/live/src/instructions.rs`).
- Hook protocol: read `crates/hook/src/hook.rs`, `hook_lib.rs` (`resolve_harness`, the `payload()` output shape, the `stop_hook_active` guard) and `build_completion.rs` (`IMPECCABLE_SESSION_ID`). Hook mode and `MANUAL_DETECTOR_REQUIRED`: `automatic_hook_mode` in `crates/context/src/context_cli.rs`; `hooks status`/`hooks on` wiring lines: `crates/hook/src/admin.rs`. The Hermes plugin (`skill/hermes-plugin/__init__.py`) is the closest upstream analogue to this plugin's hook (timeouts, event shape).
- `impeccable update` behavior (`crates/skills/src/commands.rs` `update`): `/impeccable update` mirrors what it prints after `Done!` (4.10: the doctor report).

## 2. Stage a real install outside omp
```sh
mkdir -p /tmp/stage/.git && cd /tmp/stage
node ~/Proj/p/omp-impeccable/node_modules/impeccable/cli/bin/cli.js install --providers=omp,claude-code --scope=project -y --no-hooks --force
```
- `Download failed: invalid zip data` means the CLI is too old (3.x follows one redirect); `Unknown provider(s): omp` means it predates 4.6. Bump the `impeccable` dep.
- The `omp` build should name only `.omp/skills/impeccable` paths: `grep -rlE '\.(agents|pi|claude)/skills/impeccable' --include=*.md .omp`.
- Check `scripts/impeccable --help` for renamed verbs. `live*.mjs` scripts were replaced by launcher verbs (`live`, `live-poll`, `live-status`, `live-server`, `live-complete`, `hooks`, `hook`).
- Check that `.claude/agents/*.md` frontmatter still converts. The Claude build writes camelCase keys (`disallowedTools`, `maxTurns`). OMP ignores `effort` (map it to `thinkingLevel`), treats `model: inherit` as a literal model name (drop it), and has only a `tools` allowlist (`parseAgentFields` in `pi-coding-agent/src/discovery/helpers.ts`), so `disallowedTools` must become an allowlist.

## 3. Probe the hook directly
```sh
printf '{"hook_event_name":"PostToolUse","session_id":"s","cwd":"%s","tool_name":"Write","tool_input":{"file_path":"%s/index.html"}}' $PWD $PWD | .omp/skills/impeccable/scripts/impeccable hook
```
Use an `index.html` with gradient text and low-contrast colors so findings are guaranteed. Then send a Stop event with `stop_hook_active` set to false and to true. Stop also scans UI files written through the shell, but only when the event dates the session start: a UUIDv7 `session_id` (OMP ids are UUIDv7) or the birth time of `transcript_path`, which the static musl engine cannot read on Linux. A `hooks on`/`hooks status` run in an OMP-only project prints "No design harness is wired" and "not wired in any harness"; the plugin overrides those lines.

## 4. Verify in real omp
- Discovered agents: `omp -p "Without calling tools, list task agents starting with impeccable"`.
- TUI in tmux: start a shell session (`tmux new-session -d -s imp -x 200 -y 50 -c <project>`), then `send-keys 'omp' Enter`; launching `omp` as the session command exits at once. Export `IMPECCABLE_BROWSER=<recorder script>` in that shell first, or `/impeccable live` opens the user's real browser. Send text with `send-keys -l`, then `Escape` (closes the autocomplete popup), then `Enter`. Test a free-form docs prompt, `/impeccable live status`, and `/impeccable live --delivery=aside`. Since 4.10 a plain `index.html` without CSP is enough: the boot writes `.impeccable/live/config.json` and runs without PRODUCT.md and DESIGN.md. The first Live session is the one with no `.impeccable/live/sessions/*.jsonl` yet (the boot creates the folder empty).
- Live events without a browser: read `port` and `token` from `.impeccable/live/server.json` and `curl -X POST http://localhost:<port>/events` with `{token, type, id, ...}`. Any type other than `generate`/`steer` needs a known session, so post a `steer` (`id` is 8 hex chars, plus `message` and `pageUrl`) first, then e.g. `variant_mount_failed` (`variant`, `url`, `error`) on the same id. The agent should answer through `impeccable_live_reply` and the poll should resume.
- Pinned commands registered mid-session work but only show in autocomplete after an omp restart.
- Mutation-check any new guard: remove it temporarily, confirm the test fails, then restore it.

## Pitfalls
- Unit fixtures fake `scripts/impeccable` as a sh dispatcher to `scripts/verbs/<verb>.mjs`. Real behavior only shows up in the staged install.
- `process.versions.bun` is unset under vitest, so the `BUN_BE_BUN` spawn path is only exercised in real omp.
- A `tool_call` input revision is persisted as the model's own command. The model then believes it wrote the change and may rerun the call to undo it, so pair every revision with `additionalContext` and match commands narrowly. OMP exports `PI_SESSION_ID` to bash, but the engine reads only `IMPECCABLE_SESSION_ID` or `CODEX_THREAD_ID`.
- OMP sets `CI=true` in every agent shell (`NON_INTERACTIVE_ENV` in `pi-coding-agent/src/exec/non-interactive-env.ts`; `PI_BASH_NO_CI=1` drops it). Grep new upstream code for `"CI"`: decision pages have an override (`IMPECCABLE_QUESTION_FORCE`), account syncs do not. The plugin's own `runProcess` children inherit OMP's env without `CI`.
- Update CHANGELOG `## Unreleased` with each commit; the commits are conventional, and there is no upstream PR to jenkei.
