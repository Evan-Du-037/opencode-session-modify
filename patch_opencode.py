#!/usr/bin/env python3
"""
Patch opencode v1.18.4 source:
  1. Server: add POST /session/:id/continue endpoint
  2. TUI: add /edit and /continue built-in slash commands

Usage: python3 patch_opencode.py [source_dir]
"""

import sys, os

def patch(filepath, anchor, insertion, label):
    """Insert text after anchor. Fail if anchor != 1 match."""
    with open(filepath) as f:
        content = f.read()
    # idempotency
    first_line = insertion.strip().split("\n")[0].strip()
    if first_line in content:
        print(f"  [SKIP] {label}")
        return
    # anchor must match exactly once
    count = content.count(anchor)
    if count != 1:
        raise SystemExit(f"ERROR: '{label}' anchor found {count}x (expected 1). Version mismatch?")
    pos = content.index(anchor) + len(anchor)
    with open(filepath, "w") as f:
        f.write(content[:pos] + insertion + content[pos:])
    print(f"  [OK]   {label}")


SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.opencode/src")

# ============================================================
# Part 1: Server-side patches (4 insertions, 2 files)
# ============================================================
print("Server-side patches:")

GROUPS   = f"{SRC}/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts"
HANDLERS = f"{SRC}/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts"

# A: SessionPaths
patch(GROUPS,
    '  summarize: `${root}/:sessionID/summarize`,',
    '\n  continue: `${root}/:sessionID/continue`,',
    "SessionPaths.continue")

# B: Endpoint definition
patch(GROUPS,
    '''            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),''',
    '''
        HttpApiEndpoint.post("continue", SessionPaths.continue, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Continued session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.continue",
            summary: "Continue session",
            description: "Continue generation from the last assistant message without creating a user message.",
          }),
        ),''',
    "Endpoint: POST /continue")

# C: Handler function
patch(HANDLERS,
    '''      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })''',
    '''

    const continueSession = Effect.fn("SessionHttpApi.continue")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(
        session.messages({ sessionID: ctx.params.sessionID }),
      )
      const { assistant: lastAssistant } = MessageV2.latest(messages)
      if (lastAssistant) {
        yield* session.updateMessage({
          ...lastAssistant,
          finish: undefined,
          error: undefined,
        })
      }
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })''',
    "Handler: continueSession")

# D: Handler registration
patch(HANDLERS,
    '      .handle("summarize", summarize)',
    '\n      .handle("continue", continueSession)',
    "Handler registration")

# ============================================================
# Part 2: TUI patches (2 insertions, 1 file)
# ============================================================
print("\nTUI patches:")

TUI = f"{SRC}/packages/tui/src/routes/session/index.tsx"

# E: Add to binding commands list
patch(TUI,
    '  "session.export",',
    '\n  "session.edit",\n  "session.continue",',
    "Binding commands")

# F: Add command definitions (after export command, before background subagents)
patch(TUI,
    '''        dialog.clear()
      },
    },
    {
      title: "Background subagents",''',
    '''
    {
      title: "Edit in ocedit",
      value: "session.edit",
      category: "Session",
      slash: {
        name: "edit",
      },
      run: async () => {
        const { spawn } = await import("child_process")
        try {
          await fetch("http://127.0.0.1:17654/")
          spawn("open", ["http://127.0.0.1:17654/?session=" + route.sessionID], { stdio: "ignore" })
        } catch {
          spawn("ocedit", [route.sessionID], { stdio: "ignore", detached: true })
        }
        toast.show({ message: "Opening ocedit...", variant: "info" })
        dialog.clear()
      },
    },
    {
      title: "Continue generation (no user message)",
      value: "session.continue",
      category: "Session",
      slash: {
        name: "continue",
      },
      run: async () => {
        toast.show({ message: "Generating...", variant: "info" })
        const c = (sdk.client as any).client
        if (c) c.post({ url: "/session/" + route.sessionID + "/continue" }).catch(() => {})
        dialog.clear()
      },
    },
    {
      title: "Background subagents",''',
    "Command definitions: /edit and /continue")

print("\nAll patches applied.")
