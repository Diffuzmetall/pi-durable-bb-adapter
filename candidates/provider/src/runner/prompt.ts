import { existsSync, readFileSync } from "node:fs";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSkillsForPrompt,
	type SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";

export interface ResourceLoaderLike {
	getAgentsFiles?: () => { agentsFiles: Array<{ path: string; content: string }> };
	getSkills?: () => { skills: Skill[] };
}

export interface DynamicSectionsHolder {
	getSections(): Record<string, string>;
	updateSections(sections: Record<string, string>): void;
	getRevision?(): number;
}

export class DynamicPromptSections implements DynamicSectionsHolder {
	private sections: Record<string, string> = {};
	private revision = 0;

	getSections(): Record<string, string> {
		return { ...this.sections };
	}

	updateSections(sections: Record<string, string>): void {
		this.sections = { ...sections };
		this.revision++;
	}

	getRevision(): number {
		return this.revision;
	}
}

export interface PromptOptions {
	systemPromptPath?: string;
	appendSystemPromptPath?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	resourceLoader?: ResourceLoaderLike;
	dynamicSections?: DynamicSectionsHolder;
}

const CANONICAL_TOOL_DEFS = {
	read: createReadToolDefinition(process.cwd()),
	write: createWriteToolDefinition(process.cwd()),
	edit: createEditToolDefinition(process.cwd()),
	bash: createBashToolDefinition(process.cwd()),
};

const KEYS = [
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
	"mcp_servers",
	"dynamic_sections",
] as const;

function resolveContextFiles(options: PromptOptions): Array<{ path: string; content: string }> {
	if (options.contextFiles && options.contextFiles.length > 0) return options.contextFiles;
	return options.resourceLoader?.getAgentsFiles?.()?.agentsFiles ?? [];
}

function resolveSkills(options: PromptOptions): Skill[] {
	return options.resourceLoader?.getSkills?.()?.skills ?? [];
}

interface PromptToolItem {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

function buildRules(tools: PromptToolItem[]): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	if (tools.some((t) => t.name === "bash")) {
		addRule("Use bash for file operations like ls, rg, find");
	}

	for (const tool of tools) {
		const def = CANONICAL_TOOL_DEFS[tool.name as keyof typeof CANONICAL_TOOL_DEFS];
		if (def?.promptGuidelines) {
			for (const guideline of def.promptGuidelines) addRule(guideline);
		}
		if (tool.promptGuidelines) {
			for (const guideline of tool.promptGuidelines) addRule(guideline);
		}
	}

	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((r) => `- ${r}`).join("\n");
}

function tryReadPromptFile(path?: string, label?: string): string | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8").trim();
	} catch (err) {
		console.error(`Warning: failed to read ${label ?? "prompt"}: ${err}`);
		return undefined;
	}
}

export function createPiPrompt(_settings: SettingsManager, fallbackCwd: string, options: PromptOptions = {}) {
	const systemPromptOverride = tryReadPromptFile(options.systemPromptPath, "system-prompt");
	const appendPrompt = tryReadPromptFile(options.appendSystemPromptPath, "append-system-prompt");

	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const contextFiles = resolveContextFiles(options);
		const skills = resolveSkills(options);
		const tools = (input.agent.tools ?? []) as unknown as PromptToolItem[];
		const sections: Record<string, string> = {};

		if (systemPromptOverride) {
			sections.preamble = systemPromptOverride;
		} else {
			sections.preamble =
				"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

			const visibleTools = tools.map((t) => {
				const def = CANONICAL_TOOL_DEFS[t.name as keyof typeof CANONICAL_TOOL_DEFS];
				const snippet = def?.promptSnippet ?? t.promptSnippet ?? t.description ?? "";
				return snippet ? `- ${t.name}: ${snippet}` : `- ${t.name}`;
			});
			sections.tools = `<tools>\n${visibleTools.join("\n")}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>`;
			sections.rules = `<rules>\n${buildRules(tools)}\n</rules>`;
		}

		if (appendPrompt) sections.addendum = `<addendum>\n${appendPrompt}\n</addendum>`;

		if (contextFiles.length > 0) {
			const rendered = contextFiles
				.map((cf) => `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>`)
				.join("\n\n");
			sections.project_context = `<project_context>\nProject-specific instructions and guidelines:\n\n${rendered}\n</project_context>`;
		}

		if (skills.length > 0) sections.skills = `<skills>\n${formatSkillsForPrompt(skills, "read")}\n</skills>`;

		sections.cwd = `<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`;

		if (options.dynamicSections) {
			const extra = options.dynamicSections.getSections();
			if (extra.mcp_servers?.trim()) sections.mcp_servers = `<mcp_servers>\n${extra.mcp_servers}\n</mcp_servers>`;
			const otherEntries = Object.entries(extra).filter(([k, text]) => k !== "mcp_servers" && Boolean(text?.trim()));
			if (otherEntries.length > 0) {
				sections.dynamic_sections = otherEntries.map(([name, text]) => `<${name}>\n${text}\n</${name}>`).join("\n\n");
			}
		}

		return sections;
	};

	const built = new WeakMap<PromptInput, { revision: number; sections: Record<string, string> }>();
	const getOrBuild = (input: PromptInput): Record<string, string> => {
		const currentRev = options.dynamicSections?.getRevision?.() ?? 0;
		const cached = built.get(input);
		if (cached === undefined || cached.revision !== currentRev) {
			const sections = buildSections(input);
			built.set(input, { revision: currentRev, sections });
			return sections;
		}
		return cached.sections;
	};

	return defineExtension({
		name: "pi-prompt",
		sections: KEYS.map((key) => section(key, (input) => getOrBuild(input)[key], { tag: false })),
	});
}
