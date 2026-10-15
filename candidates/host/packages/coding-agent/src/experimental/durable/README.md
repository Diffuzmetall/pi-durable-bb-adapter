# durable

A small local coding agent on `@earendil-works/pi-durable`. One process owns the model runtime, the durable
Harness, its SQLite storage, and the TUI. It reuses pi's model runtime, auth, settings, system prompt, keybindings,
theme, and interactive components; the agent itself is the durable Harness with its built-in `CodingTools`.

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts --continue
```

## MCP by default

Both plain startup and `--continue` now connect every enabled server in user-level `~/.pi/agent/mcp.json` through **one `codemode`**. Disabled servers remain off; hidden tools remain hidden. Use `ALL_TOOLS` and `searchTools()` inside scripts to discover namespaced tools. `/mcp` prints actual connection states on demand; `/mcp off` clears and hides the MCP status lines in the TUI, and `/mcp on` shows them again. These commands only affect TUI notices: MCP connections, tools and the `mcp_status` diagnostic remain available. Failed servers are reported rather than blocking healthy servers. `--no-mcp` disables the integration for this process.

Agent Mail uses a session-owned identity saved next to `session.sqlite` in `agent-mail-identity.json` (mode 0600). Startup initializes the project and registers/reuses that identity; it does not send messages or reserve files. An existing `AGENT_MAIL_AGENT` takes precedence. The verified identity is exported to this process's `AGENT_MAIL_AGENT`/`AGENT_MAIL_PROJECT`, not global settings. Every Mail call checks the current project and actor; administrative/destructive operations remain blocked. Other configured servers expose their non-hidden tools, including write tools, for explicit model calls. Scripts are unsafe replay: reconcile external state before retrying interrupted actions.

The separate implementation is [durable-mcp](../../../../../.pi/extensions/durable-mcp/README.md). It reuses Pi's transport, stored OAuth credentials, provider token resolution, and lazy reconnect. Interactive sign-in and resources are not implemented here; use ordinary Pi for sign-in. Project-supplied server commands are not admitted automatically. `/reload` does **not** reconnect MCP or reload MCP configuration; restart after changing server settings.

Already-running processes keep their old registry. Exit normally and resume from the **same working directory** once; future startup/resume needs no MCP flags. `pi-durable --continue` chooses the newest session in that directory. If several sessions share a directory, use `pi-durable --session /ABSOLUTE/PATH/TO/session.sqlite` (or its session directory) to reopen exactly the intended conversation instead. Exact selection refuses another project's database or a directory without an existing database, and retains the process lock. The shared launcher works from any project directory, including the playground checkout, without changing its standalone WIP runtime. No running process is stopped automatically and no global configuration is changed.

### Explicit single-server profiles

For an explicitly selected stdio server already enabled in the user-level `~/.pi/agent/mcp.json`, add `--mcp-server NAME --mcp-tools TOOL[,TOOL...]` to either command. For example, `--mcp-server docs --mcp-tools search,read` registers only those named read-only tools and `codemode`. The host requires `readOnlyHint: true` on every ordinary MCP call (including calls from codemode); annotations come from the server and do not establish trust by themselves.

The explicitly selected Agent Mail profile remains available: from the registered project directory, add `--mcp-server mcp-agent-mail --mcp-agent SageBay` (substitute this session's actual registered identity). It connects to the configured local HTTP or stdio server. **All tools advertised by Agent Mail are available in `codemode`** via `tools.mcp__mcp_agent_mail__<tool>({...})`; use `ALL_TOOLS`/`searchTools()` inside scripts to inspect them. Only `codemode` is exposed to the model; there are no direct Agent Mail tool registrations. Mail tools are authorized on every call, including nested script calls: `project_key`/`human_key` must match the current directory and actor arguments must match `--mcp-agent`. Do not pass another agent's name as sender or reservation owner. Administrative/destructive identity and guard operations still require separate operator approval and are rejected by this host; they are discoverable but not executable here. Mutating calls and scripts use unsafe replay: after an interrupted call, check Agent Mail's state before trying again. Avoid blindly rerunning a script that may have already sent mail or reserved paths.

For these explicit single-server profiles, project-supplied MCP configuration, interactive OAuth, MCP resources, and reconnect are not supported. An absent, disabled, or failed explicitly selected server stops startup. The host closes its MCP connection after closing the Harness. Existing running processes need restart; `--continue` resumes the saved session with the new registry. No global MCP settings are changed.

A new session starts with pi's default model and thinking level from `settings.json`. `--continue` opens the newest
session for the current directory; `--session PATH` opens exactly that existing session (these options are mutually exclusive). Sessions live under
`~/.pi/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`; a lock keeps a second process out
(a lock left by a crash goes stale after 10 seconds, and the next start waits for that). Log in with pi itself;
credentials are shared.

## Local Durable extensions and reload

`--extension PATH` / `-e PATH` explicitly loads a trusted Durable registry adapter at startup. `/reload` rereads admitted adapters without reopening the Harness or losing conversation history; `/reload PATH` admits a new adapter. Reload refuses while any Harness task is active and keeps the old registry on load failure. This is **not** the ordinary Pi ExtensionAPI loader and does not reconnect MCP servers or reload shell source/settings. Paths are process-local; repeat CLI options or `/reload PATH` after restarting.

For image reading, use `/reload /home/ubuntu/Projects/pi-upstream/.pi/extensions/durable-image-read/index.ts` in an upgraded idle shell. The implementation and contract are in [the local reload extension](../../../../../.pi/extensions/durable-reload/README.md). Old processes need one restart with `--continue` from the same directory to gain the new command; further adapter changes use `/reload`.

## What it shows

- **Durability:** every streamed partial, tool output, queue, and turn is committed. Kill the process in the middle
  of a tool call and start it again with `--continue`: the interrupted call gets an interrupted result and the turn
  finishes. Nothing in the TUI handles recovery; it only renders the conversation view.
- **One view:** the TUI renders `Conversation.viewState()`, the structural mount of the transcript and the built-in
  documents (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`). Streaming, tool progress, the queue, retries,
  compaction status, the model, and usage all come from it.
- **Subagents:** the `subagent` tool runs a task in a child conversation owned by the call. `/agents` switches the
  view to any conversation, also while the subagent works, and the editor then talks to it: steer it while busy, or
  keep chatting after the call returned. Esc aborts the shown conversation; aborting the main turn aborts its
  subagents.
- **Task graph:** a live panel of `Harness.taskGraph()`, shown by default and toggled with `/tasks`: every live task, what it waits on, and the
  conversations it owns.

## Commands

- submit: prompt while idle, steer while busy
- follow-up key (`app.message.followUp`): queue a follow-up
- Esc: abort the shown conversation's work, including a manual compaction
- `/model` or the model key: select a model for the shown conversation
- thinking key (Shift+Tab): cycle thinking levels
- `/compact [instructions]`: summarize older context; reports "Nothing to compact" when the context fits in
  `compaction.keepRecentTokens`
- `/agents`: switch conversations
- `/tasks`: hide or show the task panel
- `/reload [PATH]`: reread admitted Durable adapters; optional path loads a new trusted adapter
- `/mcp`: show current MCP connection states and tool counts (not an interactive configuration UI)
- `/mcp off` / `/mcp on`: hide and restore MCP status lines in the TUI; connections stay active
- tools expand key (Ctrl+O): expand tool output and compaction summaries
- clear key (Ctrl+C) or Ctrl+D: exit at once, unlike pi's clear-first Ctrl+C; work in flight resumes with
  `--continue`

## Layout

| file | role |
| --- | --- |
| `main.ts` | arguments, open, run, close |
| `extensions.ts` | minimal bridge to `.pi/extensions/durable-reload/` |
| `sessions.ts` | session directories and the lock |
| `runtime.ts` | Harness, registry, settings, environments; the plain `DurableView` and `DurableController` |
| `prompt.ts` | pi's system prompt sections (tools, rules, docs, AGENTS.md, skills, cwd) as one extension |
| `subagent.ts` | the foreground subagent tool |
| `tui.ts` | rendering with pi's interactive components |

Compaction thresholds, retry policy, queue modes, and request timeouts come from pi's `settings.json` as loaded at
startup, read through Harness settings getters at each use. pi's HTTP dispatcher is configured as in pi; without it some provider streams end
early.

A turn that ends without an answer shows a notice; one recovered after a restart does not, since only submissions
made by this process are watched.

Not here: sessions list and resume picker, forks and tree navigation, general Pi extensions, prompt templates, built-in image reading (use the local image adapter), `/login`, or `/mcp` UI. Codemode uses the Durable adapter above, not Pi's built-in codemode: nested calls have their own per-call authorization and do not traverse Durable's `ToolTask` hooks; scripts are not replayed after interruption.

## Native DCG shell boundary

The durable TUI and experimental CLI worker share a startup-selected execution-environment guard. It checks the final shell invocation after tool hooks, prefixes, and preparation, for root, child, fork, and reopened conversations. Registry reload and tool/profile selection cannot remove this boundary. Denied or unavailable checks block shell execution only; filesystem tools and subsequent model answers remain available. The durable TUI and experimental CLI root chat view share one presentation helper that keeps a committed failed `DCG_DENIED` / `DCG_UNAVAILABLE` diagnostic visible as one width-truncated line above the real collapsed tool card. The prefix comes only from validated committed `entry.data.diagnostics` (`error` / `tool_error`), never command stdout or combined message text. Live output, generic errors, and missing/malformed metadata do not gain this prefix; ordinary card expansion is unchanged. Focused actual-component tests in `test/durable-dcg-hosts.test.ts` cover 40/80 columns, body/prefix reuse, streaming takeover, rebuilt/reopened snapshots, and timer disposal (correction evidence: `/tmp/pi-dcg-upstream-6ODRzI41/s2-cli/`). The noninteractive CLI still returns only the final answer; this adds no CLI child viewer or full launcher/lock proof.

The native addon is separate from the host package and ordinary registry extensions. By default the bridge loads `<agent-dir>/durable-extensions/durable-dcg/index.ts`; it does not discover a repository fallback. An explicit absolute `PI_DURABLE_DCG_EXTENSION` overrides this selection. `DCG_BIN` selects the trusted binary at startup (DCG 0.10.0/schema 1); tool-supplied shell environment variables cannot change either selection. Missing/incompatible addons or unavailable checks fail closed for shell calls.

For this source checkout, from the repository root:

```bash
PI_DURABLE_DCG_EXTENSION="$PWD/.pi/extensions/durable-dcg/index.ts" \
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts --no-mcp
```

Keeping an authorized addon installation outside the checkout and host package (default `~/.pi/agent/durable-extensions/durable-dcg/`, unless the agent directory is overridden) preserves its files across compatible host package replacement. See the [separate addon contract](../../../../../.pi/extensions/durable-dcg/README.md). This change does not install one, protect it from deletion, or guarantee compatibility with a future bridge/peer ABI. The host bridge must remain present and compatible; replacing the host with an unmodified version that lacks it does not retain the execution guard. Existing processes need restart; repeat the explicit selection when reopening a saved session.
