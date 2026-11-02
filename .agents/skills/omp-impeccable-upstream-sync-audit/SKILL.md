---
name: omp-impeccable-upstream-sync-audit
description: "Use when the omp-impeccable fork breaks after upstream Impeccable changes, or to audit it against upstream skill features."
---

# omp-impeccable upstream sync audit

Fork: `Sylonin/omp-impeccable` at `~/Proj/p/omp-impeccable`, linked into omp with `omp plugin link`. Run pnpm through a corepack shim: `mkdir -p /tmp/pnpm-shim && corepack enable --install-directory /tmp/pnpm-shim pnpm`, then `PATH=/tmp/pnpm-shim:$PATH pnpm release:check`.

## 1. Find what upstream changed
- Commits since the last sync: `gh api 'repos/pbakaus/impeccable/commits?since=<date>&per_page=100' --paginate`, or a blob-filtered clone (`git clone --filter=blob:none`) and `git diff <base> HEAD -- .omp .claude/agents crates/hook crates/live crates/context docs/HARNESSES.md`.
- Upstream has its own `omp` provider (4.6+, PR #900): skill only. `docs/HARNESSES.md` lists no OMP hook and no OMP subagents, and OMP skips `.claude/agents`. Re-check that row first: if upstream ever ships OMP hooks, subagents or a background live loop, decide whether this plugin is still needed.
- Compare against `.omp/skills/impeccable/SKILL.md`: the routing rules, the command table (`grep -oE '^\| \`[a-z-]+'`), and the Pin, Hooks and Doctor lines.
- Live protocol: `EVENT_TYPES_NEEDING_AGENT_REPLY` in `crates/live/src/live_poll.rs` must match `agentReplyEvents`; check `live-complete` and `live-poll --reply` flags.
- Hook protocol: read `crates/hook/src/hook.rs`, `hook_lib.rs` (`resolve_harness`, the `payload()` output shape, the `stop_hook_active` guard) and `build_completion.rs` (`IMPECCABLE_SESSION_ID`). Hook mode and `MANUAL_DETECTOR_REQUIRED`: `automatic_hook_mode` in `crates/context/src/context_cli.rs`. The Hermes plugin (`.hermes/plugins/impeccable-design-hook`) is the closest upstream analogue to this plugin's hook.

## 2. Stage a real install outside omp
```sh
mkdir -p /tmp/stage/.git && cd /tmp/stage
node ~/Proj/p/omp-impeccable/node_modules/impeccable/cli/bin/cli.js install --providers=omp,claude-code --scope=project -y --no-hooks --force
```
- `Download failed: invalid zip data` means the CLI is too old (3.x follows one redirect); `Unknown provider(s): omp` means it predates 4.6. Bump the `impeccable` dep.
- The `omp` build should name only `.omp/skills/impeccable` paths: `grep -rlE '\.(agents|pi|claude)/skills/impeccable' --include=*.md .omp`.
- Check `scripts/impeccable --help` for renamed verbs. `live*.mjs` scripts were replaced by launcher verbs (`live`, `live-poll`, `live-status`, `live-server`, `live-complete`, `hooks`, `hook`).
- Check that `.claude/agents/*.md` frontmatter still converts. OMP ignores `effort` (map it to `thinkingLevel`) and treats `model: inherit` as a literal model name, so drop that line.

## 3. Probe the hook directly
```sh
printf '{"hook_event_name":"PostToolUse","session_id":"s","cwd":"%s","tool_name":"Write","tool_input":{"file_path":"%s/index.html"}}' $PWD $PWD | .omp/skills/impeccable/scripts/impeccable hook
```
Use an `index.html` with gradient text and low-contrast colors so findings are guaranteed. Then send a Stop event with `stop_hook_active` set to false and to true.

## 4. Verify in real omp
- Discovered agents: `omp -p "Without calling tools, list task agents starting with impeccable"`.
- TUI in tmux: start a shell session (`tmux new-session -d -s imp -x 200 -y 50 -c <project>`), then `send-keys 'omp' Enter`; launching `omp` as the session command exits at once. Send text with `send-keys -l`, then `Escape` (closes the autocomplete popup), then `Enter`. Test a free-form docs prompt, `/impeccable live status`, and `/impeccable live --delivery=aside` (needs PRODUCT.md, DESIGN.md and `.impeccable/live/config.json` with `files`, `insertBefore`, `commentSyntax`, `cspChecked: true`).
- Live events without a browser: read `port` and `token` from `.impeccable/live/server.json` and `curl -X POST http://localhost:<port>/events` with `{token, type, id, ...}`. Any type other than `generate`/`steer` needs a known session, so post a `steer` (`id` is 8 hex chars, plus `message` and `pageUrl`) first, then e.g. `variant_mount_failed` (`variant`, `url`, `error`) on the same id. The agent should answer through `impeccable_live_reply` and the poll should resume.
- Pinned commands registered mid-session work but only show in autocomplete after an omp restart.
- Mutation-check any new guard: remove it temporarily, confirm the test fails, then restore it.

## Pitfalls
- Unit fixtures fake `scripts/impeccable` as a sh dispatcher to `scripts/verbs/<verb>.mjs`. Real behavior only shows up in the staged install.
- `process.versions.bun` is unset under vitest, so the `BUN_BE_BUN` spawn path is only exercised in real omp.
- A `tool_call` input revision is persisted as the model's own command. The model then believes it wrote the change and may rerun the call to undo it, so pair every revision with `additionalContext` and match commands narrowly. OMP exports `PI_SESSION_ID` to bash, but the engine reads only `IMPECCABLE_SESSION_ID` or `CODEX_THREAD_ID`.
- Update CHANGELOG `## Unreleased` with each commit; the commits are conventional, and there is no upstream PR to jenkei.
