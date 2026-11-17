import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { storedCwdState } from "../session-cwd/index.js";
import { type CellResult, MAX_OUTPUT_BYTES, PythonKernel } from "./kernel-client.js";
import { getPythonPaths } from "./paths.mjs";

const MAX_NOTICE_BYTES = 2_000;
const MAX_NOTICE_NAME_CHARS = 64;
const PREVIEW_LINES = 12;

const PYTHON_DESCRIPTION = [
	"Persistent Python 3.15 kernel: variables survive across calls, so load data once and print only what you need; the last expression is shown.",
	`Output keeps its start and end (~${MAX_OUTPUT_BYTES / 1024}KB); the rest is saved to a file.`,
	"Lazy preloads: np, pd, pl, duckdb, yaml, httpx, Path, json, re.",
	"sh(cmd) runs in the session directory and returns .code and .out; pip(*pkgs) installs into the shared kernel venv.",
	"An interrupt or the 10-minute limit kills the kernel and the processes it started: variables are lost. Not a sandbox.",
].join(" ");

export function formatNamesNotice(names: string[]): string | undefined {
	const prefix = "[python] The kernel survived compaction; these names are still defined: ";
	const shown: string[] = [];
	let bytes = Buffer.byteLength(prefix);
	for (const name of names) {
		if (name.length > MAX_NOTICE_NAME_CHARS) continue;
		const cost = Buffer.byteLength(name) + 2;
		if (bytes + cost > MAX_NOTICE_BYTES) break;
		shown.push(name);
		bytes += cost;
	}
	if (shown.length === 0) return undefined;
	const omitted = names.length - shown.length;
	return `${prefix}${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

export default function python(pi: ExtensionAPI): void {
	const { python: interpreter, directory } = getPythonPaths();
	// Explicit setup (npm run python:install) creates the runtime; without it, stay invisible.
	if (!existsSync(interpreter)) return;
	let kernel: PythonKernel | undefined;
	const getKernel = (cwd: string) => {
		kernel ??= new PythonKernel({ python: interpreter, cwd, outputDir: join(directory, "outputs") });
		return kernel;
	};

	pi.registerTool({
		name: "python",
		label: "Python",
		description: PYTHON_DESCRIPTION,
		promptSnippet:
			"python: persistent Python 3.15 kernel for successive analysis over data kept in variables",
		promptGuidelines: [
			"Use python for successive computations over data you keep in variables (inventories, parsed logs or JSON, cross-file joins and metrics); use codemode to orchestrate tools, and read/grep or structural tools for known files and symbols.",
		],
		parameters: Type.Object({
			code: Type.String({
				description: "Python source to run in the persistent kernel; top-level await works",
			}),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const lines = highlightCode((args?.code ?? "").replace(/^\n+|\s+$/g, ""), "python");
			const shown = context.expanded ? lines : lines.slice(0, PREVIEW_LINES);
			const hidden = lines.length - shown.length;
			const more = hidden > 0 ? `\n${theme.fg("muted", `… ${hidden} more lines`)}` : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("python"))}\n${shown.join("\n")}${more}`);
			return text;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = storedCwdState(ctx).current;
			const result: CellResult = await getKernel(cwd).exec(params.code, cwd, signal);
			if (result.status !== "ok") throw new Error(result.text);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					status: result.status,
					totalBytes: result.totalBytes,
					fullOutputPath: result.fullOutputPath,
				},
			};
		},
	});

	pi.registerCommand("python-reset", {
		description: "Restart the python tool's kernel with a clean namespace",
		handler: async (_args, ctx) => {
			kernel?.reset();
			ctx.ui.notify("Python kernel reset; the next python call starts fresh.", "info");
		},
	});

	pi.on("session_compact", async () => {
		const notice = formatNamesNotice((await kernel?.names()) ?? []);
		if (notice)
			pi.sendMessage(
				{ customType: "pi-core-python", content: notice, display: false },
				{ deliverAs: "steer" },
			);
	});

	pi.on("session_shutdown", () => {
		kernel?.dispose();
		kernel = undefined;
	});
}
