# Codex Notes

This project is intentionally small and Mac-specific. Before changing behavior, run:

```sh
node --check CodexSoundWatcher.mjs
node CodexSoundWatcher.test.mjs
node CodexSoundWatcher.mjs --diagnose
```

Important assumptions:

- This is for Codex Desktop on macOS, not Codex web, VS Code, or non-Mac environments.
- The watcher reads Codex's local `~/.codex/state_5.sqlite` database and the rollout JSONL paths referenced by that database.
- `--diagnose` must not print private thread titles, IDs, rollout paths, home paths, or session content.
- The active-window suppression path depends on macOS Automation/Accessibility access to System Events. If that fails, alerts can still work with `--no-frontmost-interrupt`.
- Keep generated logs, plists, SQLite files, and JSONL session files out of shared artifacts.

Common compatibility edits:

- If Codex changes its state database path, use or extend `--state-db`.
- If Codex changes the `threads` schema, update `listActiveThreads`.
- If Codex changes JSONL event shapes, update `CodexAlertEngine` and add tests before changing sound playback.
