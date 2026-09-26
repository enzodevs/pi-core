import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expectTypeOf, it } from "vitest";
import askUserQuestion from "../extensions/ask-user-question/index.js";
import backgroundProcess from "../extensions/background-process/index.js";
import contextInspector from "../extensions/context-inspector/index.js";
import draftToggle from "../extensions/draft-toggle/index.js";
import fastMode from "../extensions/fast-mode/index.js";
import fileAutocomplete from "../extensions/file-autocomplete/index.js";
import minimalFooter from "../extensions/footer/index.js";
import imageClipboard from "../extensions/image-clipboard/index.js";
import interstellar from "../extensions/interstellar/index.js";
import jsonHeadroom from "../extensions/json-headroom/index.js";
import memoryContext from "../extensions/memory/index.js";
import idleRecap from "../extensions/recap/index.js";
import sessionCwd from "../extensions/session-cwd/index.js";
import sessionTitle from "../extensions/session-title/index.js";
import skillManager from "../extensions/skill-manager/index.js";
import backgroundAgents from "../extensions/subagent/index.js";
import sudoExtension from "../extensions/sudo/index.js";

const factories = [
	askUserQuestion,
	backgroundProcess,
	contextInspector,
	draftToggle,
	fastMode,
	fileAutocomplete,
	minimalFooter,
	imageClipboard,
	interstellar,
	jsonHeadroom,
	memoryContext,
	idleRecap,
	sessionCwd,
	sessionTitle,
	skillManager,
	backgroundAgents,
	sudoExtension,
] satisfies ExtensionFactory[];

describe("Pi public API contract", () => {
	it("keeps every extension assignable to Pi's public factory interface", () => {
		expectTypeOf(factories).toMatchTypeOf<ExtensionFactory[]>();
		expectTypeOf<ExtensionAPI>().toHaveProperty("registerTool");
		expectTypeOf<ExtensionAPI>().toHaveProperty("on");
		expectTypeOf<ExtensionContext>().toHaveProperty("modelRegistry");
		expectTypeOf<BuildSystemPromptOptions>().toHaveProperty("skills");
		expectTypeOf<ToolDefinition>().toHaveProperty("parameters");
	});
});
