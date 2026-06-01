# Codex Sound Alerts

Small macOS watcher for Codex Desktop session logs. It plays a completion sound when a turn finishes and an attention sound when Codex needs a question answered or a permission approved. Each alert sound plays once by default.

## Privacy

This source tree is safe to share as code, but generated runtime files are not. Do not publish watcher logs, generated LaunchAgent plists, Codex session `.jsonl` files, local SQLite state, or other machine-specific output. The watcher reads local Codex state at runtime from the current user's home directory; those paths and files should stay local.

The default completion and attention sounds are local one-shot assets under `Sounds/`. Completion uses `Completion.aiff`, a warm normalized chime at about 1.34 seconds. Attention uses `Attention.aiff`, a warm multi-pulse tone at about 1.36 seconds. Alerts play through plain `afplay` by default, without changing system output volume and without spoken completion afterward. If `afplay` cannot start the selected sound because Core Audio rejects the queue, attention alerts fall back to the spoken phrase and completion alerts fall back to a system beep.

Attention audio is cancelled when Codex records that the question or permission was actioned, when a new user message starts, or when the thread starts/completes another task.

Completion and attention audio are also interrupted or suppressed when the Codex app is frontmost and the Mac has seen keyboard/mouse/trackpad activity within the last 30 seconds. If Codex is not frontmost, the Mac has been idle longer than the threshold, or idle state cannot be read, the alert audio still plays. That only stops or suppresses audio; unresolved prompts still repeat later on the normal attention interval.

## Manual Use

```sh
node CodexSoundWatcher.mjs --watch
```

Before installing, run the compatibility check:

```sh
node CodexSoundWatcher.mjs --diagnose
```

`--diagnose` checks the local Mac/Codex assumptions without printing private home paths, thread IDs, thread titles, or session contents.

## Checks

```sh
node --check CodexSoundWatcher.mjs
node CodexSoundWatcher.test.mjs
node CodexSoundWatcher.mjs --diagnose
node CodexSoundWatcher.mjs --once --dry-run
node CodexSoundWatcher.mjs --test-sound done
node CodexSoundWatcher.mjs --test-sound attention
```

Use `--play-count <count>` if you want an alert sound to repeat, but the default is one play.

Use `--alert-volume <volume>` to opt into an `afplay` volume multiplier. Use `--audio-ducking` to opt into temporarily lowering system output volume during alerts, with `--duck-output-volume <n>` controlling the temporary level.

Use `--spoken-attention` or `--spoken-completion` if you explicitly want a spoken phrase after successful alert sounds. Attention alerts still use a spoken phrase as a fallback if the sound cannot start.

Use `--no-frontmost-interrupt` to disable frontmost detection, idle-aware suppression, and alert interruption. Use `--frontmost-poll-ms <ms>` to change the app focus polling interval, and `--active-idle-ms <ms>` to change the recent-activity threshold.

## Compatibility

This was built for Codex Desktop on macOS. It is not a generic Codex API client. It depends on local Codex Desktop state and macOS tools:

- Node.js
- `/usr/bin/sqlite3`
- `/usr/bin/afplay`
- `/usr/bin/osascript`
- `/usr/sbin/ioreg`
- Codex state at `~/.codex/state_5.sqlite`
- Codex rollout JSONL session logs referenced by that state database

If `--diagnose` reports zero readable Codex session logs, the watcher will not know which sessions to follow. If frontmost app detection or user idle detection warns, basic alert sounds may still work, but active-Codex suppression can be degraded. Use `--no-frontmost-interrupt` if macOS Accessibility or Automation permissions are not available.

## Troubleshooting

- `Codex state database` fails: open Codex Desktop at least once, or pass `--state-db <path>` if your Codex build stores state somewhere else.
- `active Codex threads query` fails: Codex likely changed its local SQLite schema; update `listActiveThreads` in `CodexSoundWatcher.mjs`.
- `readable Codex session logs` is zero: there may be no active unarchived Codex threads, or your Codex build may no longer store rollout JSONL paths in the same place.
- `frontmost app detection` warns: grant the terminal or LaunchAgent host Accessibility/Automation permission, or run with `--no-frontmost-interrupt`.
- Sounds do not play: run `node CodexSoundWatcher.mjs --test-sound done` and `node CodexSoundWatcher.mjs --test-sound attention`.

## Codex Implementers

If another Codex instance is adapting this, read `CODEX.md` first. Preserve the privacy boundary: diagnostic output should report counts and statuses, not local paths, thread names, thread IDs, or session content.

## LaunchAgent

Install or refresh the background watcher:

```sh
node InstallLaunchAgent.mjs --node "$(command -v node)"
```

Uninstall it:

```sh
node InstallLaunchAgent.mjs --uninstall
```
