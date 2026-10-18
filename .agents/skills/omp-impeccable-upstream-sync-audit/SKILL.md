---
name: omp-impeccable-upstream-sync-audit
description: "Use when the omp-impeccable fork breaks after upstream Impeccable changes, or to audit it against upstream skill features."
---

# omp-impeccable upstream sync audit

Fork: `Sylonin/omp-impeccable` at `~/Proj/p/omp-impeccable`, linked into omp with `omp plugin link`. Run pnpm through a corepack shim: `corepack enable --install-directory /tmp/pnpm-shim pnpm`, then `PATH=/tmp/pnpm-shim:$PATH pnpm release:check`.

## 1. Find what upstream changed
- Tree: `gh api 'repos/pbakaus/impeccable/git/trees/main?recursive=1' --jq '.tree[].path'`.
- Compare against `.agents/skills/impeccable/SKILL.md`: the routing rules, the command table (`grep -oE '^\| \`[a-z-]+'`), and the Pin, Hooks and Doctor lines.
- Diff the provider builds (`.pi` vs `.agents` vs `.claude`) to see what differs per harness. Only `.pi` uses `/impeccable`; Codex uses `$impeccable`.
- Hook protocol: read `crates/hook/src/hook.rs` and `hook_lib.rs` (the `payload()` output shape, the `stop_hook_active` guard). Consent logic: `crates/context/src/context_cli.rs`.

## 2. Stage a real install outside omp
```sh
mkdir -p /tmp/stage/.git && cd /tmp/stage
node ~/Proj/p/omp-impeccable/node_modules/impeccable/cli/bin/cli.js install --providers=pi,claude-code --scope=project -y --no-hooks --force
```
- `Download failed: invalid zip data` means the CLI is too old (3.x follows one redirect). Bump the `impeccable` dep.
- Check `scripts/impeccable --help` for renamed verbs. `live*.mjs` scripts were replaced by launcher verbs (`live`, `live-poll`, `live-status`, `live-server`, `live-complete`, `hooks`, `hook`).
- Check that `.claude/agents/*.md` frontmatter still converts. OMP ignores `effort` (map it to `thinkingLevel`) and treats `model: inherit` as a literal model name, so drop that line.

## 3. Probe the hook directly
```sh
printf '{"hook_event_name":"PostToolUse","session_id":"s","cwd":"%s","tool_name":"Write","tool_input":{"file_path":"%s/index.html"}}' $PWD $PWD | .omp/skills/impeccable/scripts/impeccable hook
```
Use an `index.html` with gradient text and low-contrast colors so findings are guaranteed. Then send a Stop event with `stop_hook_active` set to false and to true.

## 4. Verify in real omp
- Discovered agents: `omp -p "Without calling tools, list task agents starting with impeccable"`.
- TUI in tmux: send the text, then `Escape` (closes the autocomplete popup), then `Enter`. Test a free-form docs prompt, `/impeccable live status`, and `/impeccable live --delivery=aside` (needs PRODUCT.md, DESIGN.md and `.impeccable/live/config.json`).
- Mutation-check any new guard: remove it temporarily, confirm the test fails, then restore it.

## Pitfalls
- Unit fixtures fake `scripts/impeccable` as a sh dispatcher to `scripts/verbs/<verb>.mjs`. Real behavior only shows up in the staged install.
- `process.versions.bun` is unset under vitest, so the `BUN_BE_BUN` spawn path is only exercised in real omp.
- Update CHANGELOG `## Unreleased` with each commit; the commits are conventional, and there is no upstream PR to jenkei.
