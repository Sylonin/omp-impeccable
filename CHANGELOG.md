# Changelog

## Unreleased

- Draw the plugin's output as its own OMP cards, in the terminal and in Tern. `impeccable_live_reply` and `impeccable_live_complete` results show the event id, the reply status or session outcome, the changed file and that polling resumed, instead of the launcher's raw output. `/impeccable` help, hooks, update and failure output keeps its line breaks and is tinted by severity. Design hook notes render as Markdown and fold after five lines. Needs OMP 19.2.0 or later: earlier versions lack the pi-tui JSX runtime and cannot load the plugin.
- Poll live mode with `live-poll --json`. Impeccable 4.11 then records an accepted variant within two seconds instead of holding the poll for the whole account upload, and puts the page it was saved to on the event. The plugin shows that page with the accept (`Saved to Impeccable: <url>`).
- Type-check against `@oh-my-pi/pi-coding-agent` 19.2.1.
- Keep `/impeccable` help, usage, hooks and poll-failure output out of the model's context. The user still sees it in the transcript. Needs OMP 19.0.0 or later; older versions also send it to the model.
- Ask before quitting OMP while the agent is still handling a live event, since quitting then can leave its unfinished edits in source files. Needs OMP 18.18.7 or later; older versions quit without asking.
- Run the bundled `impeccable` CLI (`/impeccable install`, `/impeccable update`) under compiled `omp` binaries by setting `BUN_BE_BUN=1` for children spawned from `process.execPath`.
- Run live mode through the skill's `scripts/impeccable <verb>` launcher (`live`, `live-poll`, `live-status`, `live-server`, `live-complete`). Current Impeccable skills no longer ship the `live*.mjs` scripts. Projects with an older installed skill must run `/impeccable update` first.
- Catch failures in the live poll `close` and `error` handlers and show them as a live error, so a throw no longer ends the OMP session.
- Clear the transient status line with OMP's managed `ctx.setTimeout` instead of a raw timer.
- Add `aside` live delivery (`/impeccable live --delivery=aside`), which adds events at the next agent step without skipping running tool calls. `steer` stays the default.
- Boot `/impeccable live` the way Impeccable 4.10's live reference requires: `live --allow-missing-context --dev-url --auto-config`, plus `--target <path>` when given. Live no longer stops for a missing PRODUCT.md or DESIGN.md, and a plain HTML or Vite page gets its live config written automatically. A request in words (`/impeccable live the pricing page`) goes to the agent, which infers the target.
- After the boot, tell the user the page URL in one line and open it in their browser when no page is connected yet, following Impeccable's browser order. A project's first Live session adds the first move (click anything, say what to change, press Go). The user also hears once about a live config the boot created, missing context files, and HTML files the config leaves out.
- Hand Live to the agent when the boot finds no page URL (start or find the dev server, then boot again) or does not finish (`config_missing`, `config_invalid`, `no_page`, `target_selection_required`), with the boot's output in the message. `no_page` exits non-zero and was shown as a plain failure before.
- Require `impeccable` ^4.11.1. The 3.x CLI follows only one redirect, so `/impeccable install` and `/impeccable update` failed with `Download failed: invalid zip data` once the skill bundle moved behind a second redirect. CLIs before 4.6 also lack the `omp` provider. 4.10 set the live, hook and subagent contracts this plugin follows, and 4.11 keeps them. Upstream 4.11's pause after three live-poll timeouts does not apply here: the background poll spends no agent turns while it waits.
- Add `foundations` (the product-foundations roadmap that Impeccable 4.10 routes through the skill) to completions, help and `/impeccable pin`.
- End `/impeccable update` with the project's `impeccable doctor` report, as upstream's `impeccable update` does, plus a pointer to `/impeccable doctor` when the update installed a new version. Nothing is repaired by the update.
- Send free-form `/impeccable <request>` text and a bare `/impeccable` to the skill, as upstream routing expects, instead of warning `Unknown Impeccable command`. Add `generate`, `doctor`, and the `teach` alias to completions.
- Install upstream's OMP build (`--providers=omp`), which uses `/impeccable` command syntax and `.omp/skills/impeccable` paths, instead of the Codex build, which uses `$impeccable`.
- Install the shipped Impeccable subagents (finish reviewer, motion reviewer, documenter, asset producer, manual edit applier) into `.omp/agents`, converted from their Claude Code definitions. OMP has only a `tools` allowlist, so a Claude `disallowedTools` list (the finish reviewer denies Write, Edit and NotebookEdit) becomes the default built-in tools minus the matching OMP tools; extension and MCP tools stay available, as upstream intends.
- Run `/impeccable hooks <action>` through the skill launcher, and run the design detector hook after `edit` and `write` tool calls (5 s limit) and at the end of each agent run (30 s limit) once `/impeccable hooks on` has recorded consent. The limits match upstream's manifests. Hook events carry the session's transcript path, as Claude Code's do. OMP session ids are UUIDv7, so the end-of-run pass also finds UI files the agent wrote through the shell.
- Mark upstream's "not wired" hook lines (`hooks on`, `hooks status`) as covered while the design hook is active, both in `/impeccable hooks` output and when the agent runs the launcher's `hooks` verb. Upstream counts only harness manifests, which OMP does not have.
- Mark the `MANUAL_DETECTOR_REQUIRED` request in `impeccable context` output as covered while the design hook is active, for every entry point rather than only `/impeccable` commands.
- Prefix bash commands that run the launcher's `build-phase` verb with `IMPECCABLE_SESSION_ID`, as upstream does for Gemini, so the end-of-run hook pass can remind the agent of an unfinished comp build. A note tells the agent the extension added the export.
- Send `variant_mount_failed` and `carbonize_cleanup` live events to the agent, matching upstream's list of events that need an agent reply. Previously they only raised a notification and nobody handled them.
- Add `error` and `force` to `impeccable_live_complete` for `live-complete --error` and `--force`.
- Serve Impeccable's decision page (`serve-question`) and component review (`component-review serve`) when a user with a desktop is in the session. OMP sets `CI=true` in every shell, which Impeccable reads as no browser, so both refused. The plugin now exports `IMPECCABLE_QUESTION_FORCE=1` for the session's shells at session start, leaving commands unchanged and a user-set value alone, and opens each served page once in the user's browser, following Impeccable's browser preference order.

## 0.1.0 - 2026-06-21

Initial OMP-native release, adapted from `pi-impeccable`.

- Add `/impeccable` OMP command backed by upstream `impeccable`.
- Publish plugin metadata under `omp.extensions`.
- Stage upstream Codex-flavored Impeccable skills and store the managed project copy at `.omp/skills/impeccable` without vendoring skill files.
- Run `/impeccable live` polling in the background so OMP stays usable.
- Inject Impeccable live events and command work as hidden extension messages, not visible user prompts.
- Add `impeccable_live_reply` and `impeccable_live_complete` tools for live event responses.
- Add quiet live status UI via OMP extension status for `/impeccable live`.
- Add OMP-native `/impeccable pin` and `/impeccable unpin` command shortcuts.
- Treat upstream hook manifests as non-native and direct users to OMP live mode instead.
- Add transient status feedback for queued Impeccable commands without replacing live status.
- Stop argument autocomplete after the first word so `/impeccable craft foo` cannot collapse back to `/impeccable craft`.
- Handle `stop live` and `/impeccable stop` quietly.
- Summarize `/impeccable status` instead of dumping raw JSON.
