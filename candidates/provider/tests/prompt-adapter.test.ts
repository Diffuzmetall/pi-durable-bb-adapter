import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiPrompt } from "../src/runner/prompt.ts";

function createMockPromptInput(options: {
	tools?: string[];
	cwd?: string;
}) {
	return {
		conversationId: "conv_test",
		agent: {
			cwd: options.cwd ?? "/test/cwd",
			tools: (options.tools ?? ["read", "bash", "edit", "write"]).map((name) => ({ name })),
		},
	} as any;
}

describe("Prompt Adapter (Cycle 61 - AP-010, AP-018)", () => {
	it("derives tool snippets directly from canonical tool definitions", () => {
		const settings = SettingsManager.inMemory();
		const extension = createPiPrompt(settings, "/test/cwd");

		const toolsSection = extension.sections?.find((s) => s.key === "tools");
		assert.ok(toolsSection, "tools section must be registered");

		const input = createMockPromptInput({ tools: ["read", "write", "edit", "bash"] });
		const rendered = toolsSection.render(input, {} as any) as string;

		const readDef = createReadToolDefinition();
		const writeDef = createWriteToolDefinition();
		const editDef = createEditToolDefinition();
		const bashDef = createBashToolDefinition();

		assert.ok(
			rendered.includes(`- read: ${readDef.promptSnippet}`),
			"must include canonical read prompt snippet",
		);
		assert.ok(
			rendered.includes(`- write: ${writeDef.promptSnippet}`),
			"must include canonical write prompt snippet",
		);
		assert.ok(
			rendered.includes(`- edit: ${editDef.promptSnippet}`),
			"must include canonical edit prompt snippet",
		);
		assert.ok(
			rendered.includes(`- bash: ${bashDef.promptSnippet}`),
			"must include canonical bash prompt snippet",
		);
	});

	it("maps canonical tool guidelines into rules section", () => {
		const settings = SettingsManager.inMemory();
		const extension = createPiPrompt(settings, "/test/cwd");

		const rulesSection = extension.sections?.find((s) => s.key === "rules");
		assert.ok(rulesSection, "rules section must be registered");

		const input = createMockPromptInput({ tools: ["read", "write", "edit", "bash"] });
		const rendered = rulesSection.render(input, {} as any) as string;

		const readDef = createReadToolDefinition();
		for (const guideline of readDef.promptGuidelines ?? []) {
			assert.ok(rendered.includes(guideline), `rules must include read guideline: ${guideline}`);
		}

		const editDef = createEditToolDefinition();
		for (const guideline of editDef.promptGuidelines ?? []) {
			assert.ok(rendered.includes(guideline), `rules must include edit guideline: ${guideline}`);
		}
	});

	it("injects context files provided via resourceLoader.getAgentsFiles()", () => {
		const settings = SettingsManager.inMemory();
		const mockResourceLoader = {
			getAgentsFiles: () => ({
				agentsFiles: [
					{ path: "/repo/AGENTS.md", content: "# Repo Instructions\nRule 1: Always verify." },
					{ path: "/repo/sub/AGENTS.md", content: "# Sub Instructions\nRule 2: Be clean." },
				],
			}),
		};

		const extension = createPiPrompt(settings, "/repo", {
			resourceLoader: mockResourceLoader,
		});

		const projectContextSection = extension.sections?.find((s) => s.key === "project_context");
		assert.ok(projectContextSection, "project_context section must be registered");

		const input = createMockPromptInput({ cwd: "/repo" });
		const rendered = projectContextSection.render(input, {} as any) as string;

		assert.ok(rendered.includes('<project_instructions path="/repo/AGENTS.md">'));
		assert.ok(rendered.includes("# Repo Instructions\nRule 1: Always verify."));
		assert.ok(rendered.includes('<project_instructions path="/repo/sub/AGENTS.md">'));
		assert.ok(rendered.includes("# Sub Instructions\nRule 2: Be clean."));
	});

	it("injects context files provided directly via promptOptions.contextFiles", () => {
		const settings = SettingsManager.inMemory();
		const extension = createPiPrompt(settings, "/workspace", {
			contextFiles: [{ path: "/workspace/AGENTS.md", content: "Direct agents context" }],
		});

		const projectContextSection = extension.sections?.find((s) => s.key === "project_context");
		assert.ok(projectContextSection);

		const input = createMockPromptInput({ cwd: "/workspace" });
		const rendered = projectContextSection.render(input, {} as any) as string;

		assert.ok(rendered.includes('<project_instructions path="/workspace/AGENTS.md">'));
		assert.ok(rendered.includes("Direct agents context"));
	});

	it("formats skills when resourceLoader provides skills", () => {
		const settings = SettingsManager.inMemory();
		const mockSkill = {
			name: "test-skill",
			description: "A test skill for verification",
			filePath: "/repo/skills/test-skill/SKILL.md",
			baseDir: "/repo/skills/test-skill",
			source: "repo" as const,
		};
		const mockResourceLoader = {
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSkills: () => ({ skills: [mockSkill] }),
		};

		const extension = createPiPrompt(settings, "/repo", {
			resourceLoader: mockResourceLoader,
		});

		const skillsSection = extension.sections?.find((s) => s.key === "skills");
		assert.ok(skillsSection, "skills section must be registered");

		const input = createMockPromptInput({ cwd: "/repo" });
		const rendered = skillsSection.render(input, {} as any) as string;

		assert.ok(rendered.includes("test-skill"));
		assert.ok(rendered.includes("A test skill for verification"));
	});

	it("renders prompt guidelines for extension tools registered on input.agent.tools", () => {
		const settings = SettingsManager.inMemory();
		const extension = createPiPrompt(settings, "/test/cwd");

		const rulesSection = extension.sections?.find((s) => s.key === "rules");
		const toolsSection = extension.sections?.find((s) => s.key === "tools");
		assert.ok(rulesSection);
		assert.ok(toolsSection);

		const input = {
			conversationId: "conv_test",
			agent: {
				cwd: "/test/cwd",
				tools: [
					{ name: "read" },
					{
						name: "agent_spawn",
						description: "Spawn a child agent",
						promptGuidelines: ["Never spawn recursive cycles of agents"],
					},
				],
			},
		} as any;

		const rulesRendered = rulesSection.render(input, {} as any) as string;
		assert.ok(
			rulesRendered.includes("Never spawn recursive cycles of agents"),
			`rules must include agent_spawn guideline: ${rulesRendered}`,
		);

		const toolsRendered = toolsSection.render(input, {} as any) as string;
		assert.ok(
			toolsRendered.includes("agent_spawn: Spawn a child agent"),
			`tools must include agent_spawn snippet: ${toolsRendered}`,
		);
	});
});
