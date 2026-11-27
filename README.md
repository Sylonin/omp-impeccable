# omp-impeccable

Run Impeccable skills from OMP without blocking the agent.

<p align="center">
  <img src="docs/images/omp-impeccable.svg" alt="omp-impeccable: OMP bridge for Impeccable live mode" width="720">
</p>

`omp-impeccable` is a native OMP plugin for the upstream [`impeccable`](https://github.com/pbakaus/impeccable) package. It installs or updates the Impeccable skill in your project, exposes `/impeccable` inside OMP, and runs Impeccable live mode in the background.

That means you can keep chatting with the agent while Impeccable watches the browser, queues design feedback, and asks OMP to respond. No long-running `impeccable live-poll` command holds the shell hostage.

## Why use this?

- **Native OMP plugin manifest** — package metadata uses `omp.extensions`, so `omp plugin install` loads it directly.
- **Non-blocking live mode** — `/impeccable live` starts the helper server and background poller, then immediately returns control to OMP.
- **Agent-native feedback loop** — browser events and Impeccable work arrive as hidden OMP extension messages.
- **Quiet status UI** — OMP shows a compact `impeccable live` status while the background bridge is running.
- **Upstream skill, no vendoring** — the plugin uses the official `impeccable` package to install/update upstream's OMP build of the skill into `.omp/skills/impeccable`, converts the shipped subagents into `.omp/agents`, then publishes that skill path through OMP resource discovery.

### Compared with upstream's own OMP support

Since Impeccable 4.6, `npx impeccable install --providers=omp` installs the skill into `.omp/skills/impeccable` or `~/.omp/agent/skills`. That install is the same skill this plugin installs. As of 4.11, upstream still leaves the rest out for OMP:

| | Upstream `--providers=omp` | omp-impeccable |
|---|---|---|
| Entry point | `/skill:impeccable <request>` | `/impeccable <request>` with command completions, `/impeccable pin` shortcuts |
| Subagents | None: OMP does not read `.claude/agents`, so the skill falls back to in-thread passes | Shipped subagents (finish reviewer, motion reviewer, documenter, asset producer, manual edit applier) converted into `.omp/agents` |
| Design hook | None; the skill asks for one manual detector run instead, and `hooks status` reports no wired harness | Runs after `edit`/`write` and when the agent finishes |
| Live mode | The agent runs `live-poll` as a foreground loop and pauses it after three empty 10-minute polls | Background poll that keeps waiting without spending agent turns; events arrive as hidden messages while OMP stays usable |
| Decision page and component review | `serve-question` and `component-review serve` refuse with "no browser", because OMP sets `CI=true` in its shell | Served, and opened in your browser |

## Install

```bash
omp plugin install omp-impeccable
```

Local testing from this checkout:

```bash
omp -e ./extensions/impeccable.ts
```

## Use

Install or update the upstream Impeccable skill:

```text
/impeccable install              # installs latest upstream skill into .omp/skills/impeccable and its subagents into .omp/agents
/impeccable update               # updates that skill from upstream, then shows the project's doctor report
```

Run Impeccable from OMP. As in the [Impeccable docs](https://impeccable.style/docs/), `/impeccable` takes a command or a plain request, and anything that is not one of the OMP commands below goes to the skill as written:

```text
/impeccable                      # suggests next steps for this project
/impeccable init
/impeccable shape new onboarding flow
/impeccable craft empty dashboard state
/impeccable audit src/pages/Home.tsx
/impeccable check whether image generation is available for this project
```

A request that starts with an OMP command word (`install`, `update`, `live`, `status`, `stop`, `pin`, `unpin`, `hooks`, `help`) runs that command instead. The upstream `pin`, `unpin`, and `hooks` commands are adapted for OMP:

```text
/impeccable pin audit       # creates a native /audit shortcut in .omp/commands/audit.md
/impeccable unpin audit     # removes that shortcut file
/impeccable hooks on        # turns on the design detector hook for this project
/impeccable hooks           # shows the hook state; also off, ignore-rule, ignore-file, ignore-value, reset
```

Pinned shortcuts are handled by the plugin when it is loaded. The `.omp/commands/*.md` file is also a native OMP fallback prompt, so the project still documents the shortcut.

Upstream installs the design hook as a harness manifest. OMP has none, so the plugin runs the same hook itself once `/impeccable hooks on` has recorded consent in `.impeccable/config.local.json`. It scans files changed by the `edit` and `write` tools and appends findings to the tool result. When the agent finishes, it runs upstream's deep pass over the files changed during the session, including UI files the agent wrote through the shell, and, if there are findings, starts one follow-up turn to handle them. Upstream `impeccable context` and `hooks status` cannot see this hook, so the plugin marks their `MANUAL_DETECTOR_REQUIRED` request and "not wired" lines as covered. It also passes the OMP session id to `build-phase` commands, so the end-of-run pass can remind the agent of a comp build it left unfinished.

Start the non-blocking live loop:

```text
/impeccable live
/impeccable live --target apps/web/src/pages/pricing.tsx
/impeccable live the pricing page
```

The plugin boots Live with the flags upstream's live reference requires (`--allow-missing-context --dev-url --auto-config`), so a missing PRODUCT.md or DESIGN.md does not block it and a plain HTML or Vite page gets its live config written for you. `--target` is passed to the boot; a request in words goes to the agent, which works out the target. The plugin then tells you the page URL and opens it in your browser when no page is connected yet, using the same browser order as decision pages. When the boot finds no running dev server, or needs setup it cannot do alone, the agent takes over and boots again once it is fixed.

While live mode is running, OMP remains usable. Impeccable events are delivered in the background, and the agent can reply through `impeccable_live_reply` / `impeccable_live_complete` without exposing the polling loop as a foreground task.

By default, a live event that arrives while the agent is busy steers the current turn. Choose another delivery mode with `--delivery`:

```text
/impeccable live --delivery=steer      # default: deliver after the running tool, skip the remaining tool calls
/impeccable live --delivery=followUp   # deliver after the agent finishes its current work
/impeccable live --delivery=aside      # deliver at the next step, without skipping the running tool calls
```

Check or stop live mode:

```text
/impeccable live status
/impeccable live stop
/impeccable stop
```

You can also say `stop live` to stop it quietly. Quitting OMP while the agent is still handling a live event asks you to confirm first.

### Decision pages and component reviews

Impeccable asks for some choices on a local web page: the direction round's decision page (`serve-question`) and the component review (`component-review serve`). Both refuse to start when `CI` is set, and OMP sets `CI=true` in every shell command, so on their own they report "no browser" even with you at the desktop.

When the OMP session has a UI and its own environment shows a desktop (no `CI`, a display on Linux, not SSH without one), the plugin exports Impeccable's `IMPECCABLE_QUESTION_FORCE=1` override for the session's shells. Commands stay as the agent wrote them. Once a page prints its URL, the plugin opens it in your browser and tells the agent so. The browser follows Impeccable's own order: `IMPECCABLE_BROWSER`, then `browser` in `.impeccable/config.local.json` or `config.json`, then `BROWSER`, then the system opener. A blocking `serve-question` and `serve-question --start --open` open the page themselves. A value of `IMPECCABLE_QUESTION_FORCE` you set yourself is left alone.

### Impeccable account features

A signed-in Impeccable account (`npx impeccable login`) adds background work that the launcher skips while `CI` is set: design health sync, critique and prototype history uploads, daily setup reports, and taste and switch sync. Because OMP sets `CI=true` in every agent shell command, that work does not run from commands the agent runs, and the plugin has no Impeccable override for it as it does for decision pages. Set `PI_BASH_NO_CI=1` before starting OMP if you want it; that drops `CI=true` from every agent command, not only Impeccable's. The plugin's own background live poll runs without `CI`, so a variant you accept is saved to your account, and the plugin tells you the page it was saved to. Upstream connects its `impeccable` MCP server and Loop to Claude Code, Codex, Cursor, GitHub Copilot CLI and opencode (`impeccable loop connect`), not to OMP, so the plugin does not add them either.

## Attribution

This plugin continues [`omp-impeccable`](https://github.com/jenkei/omp-impeccable) by jenkei, the OMP-native port of [`pi-impeccable`](https://github.com/jordi9/pi-impeccable) by jordi9. The upstream Impeccable package and skill are created by [Paul Bakaus](https://github.com/pbakaus) and live at [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable). This repository is only the OMP adapter; it does not vendor Impeccable.

## Release

Releases are tag-driven:

1. Bump `package.json`.
2. Update `CHANGELOG.md`.
3. Run release checks.
4. Push `main`, then create and push the matching Git tag.

```bash
pnpm release:check
git-cliff --unreleased --tag v0.1.0
git tag v0.1.0 main
git push origin main v0.1.0
```

## License

Apache-2.0, matching upstream Impeccable.
