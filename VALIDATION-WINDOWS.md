# Windows desktop validation

Validated on 2026-10-15, Windows x64, Node.js 24.21.0, Bun 1.4.2,
Electron 44.4.5 and OpenCode 2.0.29.

## Automated checks

- `bun test tests --timeout 30000` with `OCEDIT_REAL_OPENCODE` pointing to the
  installed native OpenCode executable: **15 passed, 0 failed, 89 assertions**.
- Real V2 sessions used private XDG data, configuration, state and cache folders
  and standalone CLI calls. No real user sessions were imported or modified.
- V1 fixture regression: read/search/export, large export integrity, clone IDs,
  failed import/export cleanup, parent pipe loss and clean backend shutdown.
- V2 integration: read/search/folder filtering, edit text/tool input/output/error,
  save a new session, re-export and confirm the original is unchanged.
- Windows-specific: case-insensitive PATH key normalization, native npm OpenCode
  discovery behind `.cmd` shims, paths with spaces, rejection of non-executable
  overrides, and forced cleanup of an unresponsive owned process tree.
- Windows folder-picker paths are tested against OpenCode's forward-slash storage.

## Packaged application

`node scripts/build.mjs` produced the Windows x64 portable application directory
with an embedded `bun.exe` and backend source outside `app.asar`.

With `OCEDIT_TEST_V2=1`, `node scripts/smoke.mjs` passed against the packaged app.
The same smoke test passed after copying the app to a separate output directory:

- Real Electron window with isolated/context-isolated renderer and preload API.
- V2 tool editing, JSON validation, reasoning deletion and assistant insertion.
- Save as a new session and native re-export verification.
- Second instance exits and leaves one application window.
- App exit closes its backend port and process.

The actual npm-installed OpenCode 2.0.29 executable was also discovered without
an override. The portable app requires the whole output folder, not just its EXE.
It is unsigned. macOS code paths are retained but were not rerun on macOS here.
