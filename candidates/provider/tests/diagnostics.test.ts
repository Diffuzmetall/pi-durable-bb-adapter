import test from "node:test";
import assert from "node:assert/strict";
import { inspectPiEnvironment, SUPPORTED_EXTENSION_HOOKS } from "../src/runner/diagnostics.ts";

test("Pi Diagnostics: inspectPiEnvironment returns well-formed report", async () => {
  const report = await inspectPiEnvironment({ cwd: process.cwd() });

  assert.ok(report.agentDir, "agentDir must be resolved");
  assert.ok(typeof report.status === "string", "status must be string");
  assert.ok(["healthy", "warning", "error"].includes(report.status), "status must be valid enum");
  assert.ok(report.paths["settings.json"], "settings.json path must be checked");
  assert.ok(report.paths["mcp.json"], "mcp.json path must be checked");
  assert.ok(Array.isArray(report.models.providers), "models.providers must be array");
  assert.ok(Array.isArray(report.extensions.items), "extensions.items must be array");
  assert.ok(typeof report.skills.total === "number", "skills.total must be number");
  assert.ok(typeof report.tools.total === "number", "tools.total must be number");
  assert.ok(typeof report.summary === "string", "summary must be string");
});

test("Pi Diagnostics: correctly classifies supported vs unsupported extension hooks", () => {
  assert.ok(SUPPORTED_EXTENSION_HOOKS.has("session_start"));
  assert.ok(SUPPORTED_EXTENSION_HOOKS.has("before_agent_start"));
  assert.ok(SUPPORTED_EXTENSION_HOOKS.has("tool_call"));
  assert.ok(SUPPORTED_EXTENSION_HOOKS.has("tool_result"));
  assert.ok(SUPPORTED_EXTENSION_HOOKS.has("session_shutdown"));

  assert.ok(!SUPPORTED_EXTENSION_HOOKS.has("agent_settled"));
  assert.ok(!SUPPORTED_EXTENSION_HOOKS.has("agent_before_settle"));
  assert.ok(!SUPPORTED_EXTENSION_HOOKS.has("turn_start"));
  assert.ok(!SUPPORTED_EXTENSION_HOOKS.has("agent_start"));
});
