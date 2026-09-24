# Changelog

## Unreleased

- Type-check against `@oh-my-pi/pi-coding-agent` 18.3.
- Run the bundled `impeccable` CLI (`/impeccable install`, `/impeccable update`) under compiled `omp` binaries by setting `BUN_BE_BUN=1` for children spawned from `process.execPath`.
- Run live mode through the skill's `scripts/impeccable <verb>` launcher (`live`, `live-poll`, `live-status`, `live-server`, `live-complete`). Current Impeccable skills no longer ship the `live*.mjs` scripts. Projects with an older installed skill must run `/impeccable update` first.
- Catch failures in the live poll `close` and `error` handlers and show them as a live error, so a throw no longer ends the OMP session.
- Clear the transient status line with OMP's managed `ctx.setTimeout` instead of a raw timer.
- Add `aside` live delivery (`/impeccable live --delivery=aside`), which adds events at the next agent step without skipping running tool calls. `steer` stays the default.
- Require `impeccable` ^4.1.0. The 3.x CLI follows only one redirect, so `/impeccable install` and `/impeccable update` failed with `Download failed: invalid zip data` once the skill bundle moved behind a second redirect.

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
