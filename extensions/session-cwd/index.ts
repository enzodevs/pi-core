import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";

const ENTRY_TYPE = "session-cwd-state";
const STATUS_ID = "session-cwd";

type CwdState = { current: string; stack: string[] };
type StoredState = CwdState & { original: string };

function displayPath(path: string, original: string): string {
	const rel = relative(original, path);
	return rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? path : `./${rel}`;
}

async function directory(path: string): Promise<string> {
	const absolute = resolve(path);
	if (!(await stat(absolute)).isDirectory()) throw new Error(`Not a directory: ${absolute}`);
	return absolute;
}

export default function sessionCwd(pi: ExtensionAPI): void {
	let original = process.cwd();
	let state: CwdState = { current: original, stack: [] };

	const updateStatus = (ctx: ExtensionContext) => {
		const changed = state.current !== original;
		ctx.ui.setStatus(
			STATUS_ID,
			changed ? ctx.ui.theme.fg("accent", `cwd ${displayPath(state.current, original)}`) : undefined,
		);
	};

	const save = (ctx: ExtensionContext) => {
		pi.appendEntry(ENTRY_TYPE, { original, ...state } satisfies StoredState);
		updateStatus(ctx);
	};

	const set = async (path: string, ctx: ExtensionContext, push: boolean) => {
		const next = await directory(resolve(state.current, path));
		if (push && next !== state.current) state.stack.push(state.current);
		state.current = next;
		save(ctx);
		return state.current;
	};

	function dynamic<TParams extends TSchema, TDetails, TState>(
		factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
	): ToolDefinition<TParams, TDetails, TState> {
		const definition = factory(state.current);
		return {
			...definition,
			execute: (id, params, signal, onUpdate, ctx) =>
				factory(state.current).execute(id, params, signal, onUpdate, ctx),
		};
	}

	pi.registerTool(dynamic(createBashToolDefinition));
	pi.registerTool(dynamic(createReadToolDefinition));
	pi.registerTool(dynamic(createWriteToolDefinition));
	pi.registerTool(dynamic(createEditToolDefinition));
	pi.registerTool(dynamic(createGrepToolDefinition));
	pi.registerTool(dynamic(createFindToolDefinition));
	pi.registerTool(dynamic(createLsToolDefinition));

	const parameters = Type.Object({
		action: Type.Union([
			Type.Literal("get"),
			Type.Literal("set"),
			Type.Literal("push"),
			Type.Literal("pop"),
			Type.Literal("reset"),
		]),
		path: Type.Optional(
			Type.String({ description: "Directory for set or push; relative paths use the active CWD" }),
		),
	});

	pi.registerTool({
		name: "session_cwd",
		label: "Session CWD",
		description:
			"Inspect or change the session working directory used by bash and built-in filesystem tools.",
		promptSnippet: "Change or inspect the session-scoped working directory",
		parameters,
		execute: async (_id, params: Static<typeof parameters>, _signal, _onUpdate, ctx) => {
			try {
				switch (params.action) {
					case "get":
						break;
					case "set":
					case "push":
						if (!params.path) throw new Error(`path is required for ${params.action}`);
						await set(params.path, ctx, params.action === "push");
						break;
					case "pop":
						state.current = state.stack.pop() ?? original;
						save(ctx);
						break;
					case "reset":
						state = { current: original, stack: [] };
						save(ctx);
						break;
				}
				return {
					content: [{ type: "text", text: `Working directory: ${state.current}` }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("cwd", {
		description: "Show or change the session working directory",
		handler: async (args, ctx) => {
			try {
				const input = args.trim();
				if (input === "--reset") {
					state = { current: original, stack: [] };
					save(ctx);
				} else if (input === "-") {
					state.current = state.stack.pop() ?? original;
					save(ctx);
				} else if (input) {
					await set(input, ctx, true);
				}
				ctx.ui.notify(`Working directory: ${state.current}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		original = ctx.cwd;
		state = { current: original, stack: [] };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const stored = entry.data as Partial<StoredState>;
			if (stored.original === original && typeof stored.current === "string" && Array.isArray(stored.stack)) {
				state = {
					current: stored.current,
					stack: stored.stack.filter((path): path is string => typeof path === "string"),
				};
			}
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_ID, undefined));
}
