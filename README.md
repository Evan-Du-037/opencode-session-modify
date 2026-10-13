# OpenCode Session Editor

English | [简体中文](README.zh-CN.md)

A desktop tool for browsing and editing local OpenCode sessions. It automatically detects OpenCode v1 or v2 and saves edits as a **new session** through the official import command, leaving the original session unchanged. Verified with OpenCode **v2.0.26**.

## Editing sessions

Tool calls are collapsed by default. Expand a tool call, then expand its input or output separately. The left pane shows the read-only original; the right pane is editable. JSON input is formatted and validated, and long content scrolls inside the editor. Drafts survive collapsing sections and other editing operations. Invalid JSON blocks saving.

- **OpenCode v1:** tool output can be plain text or JSON encoded as text. Failed tool calls also have editable error output.
- **OpenCode v2:** tool output is edited as a `content` JSON array, with text in each text item's `text` field. Errors use structured JSON.
- Attachments, model changes, system messages, and compaction records are retained in the saved copy. Compaction `summary` and `recent` text can be edited; other timeline event details are read-only.

OpenCode v2's official export includes only settled messages. Wait for an in-progress response to finish, then reopen the session to include it. Legacy v1 sessions must first be migrated by OpenCode before they appear in the v2 session list.

## macOS app

For the versioned 1.1.0 build on Apple Silicon, open:

```text
dist/1.1.0/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app
```

You can also drag the app into Applications. The app bundles Bun and runs in its own window without a terminal or browser. OpenCode must still be installed locally.

- Opening the app again brings the existing window forward.
- Closing the last window or pressing `⌘Q` stops the app and its backend.
- Closing or refreshing a window with unsaved changes prompts for confirmation.
- Native directory selection, clipboard access, and standard editing shortcuts are supported.
- Executables are discovered through `PATH`, `~/.opencode/bin`, `~/.bun/bin`, `~/.local/bin`, and Homebrew locations.
- Set `OCEDIT_OPENCODE` to use an OpenCode executable installed in a nonstandard location.

Builds target the host architecture and use a local ad-hoc signature. They are not Developer ID signed or notarized.

A desktop alias continues to point to the app it was created for. If you build a new version in a separate directory, recreate the alias for that version.

## Development and building

Requires Node.js, npm, Bun, and OpenCode. On macOS:

```sh
npm ci
npm start
npm test
npm run build
npm run test:app

# Run isolated integration tests with the installed OpenCode v2 CLI.
OCEDIT_REAL_OPENCODE="$HOME/.opencode/bin/opencode" npm test
OCEDIT_TEST_V2=1 npm run test:app
```

`npm run build` bundles the host's Bun runtime and the backend into the app under `dist/`. The resulting app does not depend on this source checkout.

To keep an older build, choose a separate output directory and pass the resulting app path to the smoke tests:

```sh
OCEDIT_BUILD_OUT=dist/1.1.0 npm run build
npm run test:app -- "dist/1.1.0/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app"
OCEDIT_TEST_V2=1 npm run test:app -- "dist/1.1.0/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app"
```

These paths assume Apple Silicon; the build script uses the current machine's architecture. The v2 desktop test defaults to `~/.opencode/bin/opencode`; set `OCEDIT_REAL_OPENCODE` if the executable is elsewhere.

## Implementation and tests

The Electron main process is in `electron/main.cjs`. It starts an independent Bun backend through `electron/runtime.cjs` and waits for it to become ready on a random loopback port. Desktop requests use a token generated for each launch. The renderer is sandboxed and context-isolated, with a limited preload interface for directory selection and clipboard access.

For v2, the backend locates the database with `opencode debug paths`, queries `session_v2` and `session_message` in read-only mode, and uses `opencode session export` / `opencode session import` to transfer sessions. The v1 path uses the legacy schema and commands.

The v1 regression tests use a temporary SQLite database and a mock CLI. The v2 integration tests use the real CLI with isolated XDG data/configuration directories and temporary servers. They cover listing, searching, text and tool edits, cloning, and re-exporting, while checking that the source session remains unchanged. Tests do not write to your real sessions.

## Browser mode

You can still run `bun run src/server.ts`, or use the `ocedit` command installed by `./install.sh`. The `shortcut.sh` script creates the legacy terminal launcher; open the `.app` directly for desktop mode.
