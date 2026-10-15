Run BB agent threads with the Pi Durable ACID SQLite runtime, offering persistent conversations and deterministic session resumption.

## What it does

- **Durable Agent Sessions:** Replaces stateless process execution with Pi's ACID-compliant SQLite backend (`session.sqlite`). Every message, tool invocation, and thought delta is preserved transactionally on disk.
- **Self-Contained Runner:** Ships with an internal pre-bundled RPC bridge runner, ensuring plug-and-play execution without custom external CLI binaries.
- **Full Visual Parity:** Interactive bash terminal execution, syntax-highlighted Diff Viewer for file edits, thinking accordion streaming, live context window metering, and the live task graph as BB's plan panel.
- **Dynamic Model Discovery:** Connects to Pi's model registry and local extensions, exposing all authenticated models directly in BB with multi-level reasoning controls.
- **Native Skill Integration:** Seamlessly maps `.pi/agent/skills`, `.agents/skills`, and workspace skill roots into BB's skill registry.

## Prerequisites

1. Node.js >= 22.19.0.
2. `@earendil-works/pi-durable` installed globally: `npm install -g @earendil-works/pi-durable`.
3. Model authentication configured in standard `pi` CLI (`pi login`).
