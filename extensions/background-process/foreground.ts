import {
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProcessLog } from "./log-store.js";
import type { ProcessResult } from "./process.js";

export const FOREGROUND_PROCESS_EVENT = "pi-core:foreground-process";
const FOREGROUND_WAIT_MS = 10_000;

export interface ForegroundProcess {
	id: string;
	log: ProcessLog;
	promote(): void;
	finish(result: ProcessResult): void;
	release(): void;
}

export interface ForegroundProcessRequest {
	command: string;
	cwd: string;
	timeoutSeconds?: number;
	stop(): void;
	accept(process: ForegroundProcess): void;
}

const PendingOutput = Type.Object({
	status: Type.Literal("running"),
	process_id: Type.String(),
	output: Type.String(),
	wall_time_seconds: Type.Number(),
});

/** Keep Pi's shell execution, environment, timeout and output handling; only yield the tool call. */
export function createManagedBashDefinition(
	cwd: string,
	pi: Pick<ExtensionAPI, "events">,
	foregroundWaitMs = FOREGROUND_WAIT_MS,
) {
	const base = createBashToolDefinition(cwd);
	if (!base.outputSchema) throw new Error("Pi bash output schema is required for process handoff");
	return {
		...base,
		description: `${base.description} In interactive mode, commands still running after 10s return status=running and process_id (no exit_code); use process_control for logs or cancellation. Completion is notified automatically.`,
		outputSchema: Type.Union([base.outputSchema, PendingOutput]),
		async execute(...args: Parameters<typeof base.execute>) {
			const [id, params, signal, onUpdate, ctx] = args;
			if (ctx.mode !== "tui" || signal?.aborted) return base.execute(...args);
			const controller = new AbortController();
			let stopped = false;
			let process: ForegroundProcess | undefined;
			pi.events.emit(FOREGROUND_PROCESS_EVENT, {
				command: params.command,
				cwd: ctx.cwd || cwd,
				timeoutSeconds: params.timeout,
				stop: () => {
					stopped = true;
					controller.abort();
				},
				accept: (value: ForegroundProcess) => {
					process = value;
				},
			} satisfies ForegroundProcessRequest);
			// Background extension absent or at capacity: retain the normal foreground contract.
			if (!process) return base.execute(...args);
			const tracked = process;
			let promoted = false;
			let captureError: unknown;
			let collecting = true;
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			const operations = createLocalBashOperations();
			const native = createBashToolDefinition(cwd, {
				operations: {
					exec: (command, directory, options) =>
						operations.exec(command, directory, {
							...options,
							onData: (data) => {
								if (!collecting) return;
								try {
									tracked.log.append(data);
								} catch (error) {
									captureError = error;
									controller.abort();
								}
								options.onData(data);
							},
						}),
				},
			});
			const started = Date.now();
			const completion = native
				.execute(
					id,
					params,
					controller.signal,
					(update) => {
						if (!promoted) onUpdate?.(update);
					},
					ctx,
				)
				.then(
					(result) => {
						collecting = false;
						tracked.finish({
							status: result.isError ? "failed" : "complete",
							exitCode: (result.structuredContent as { exit_code: number } | undefined)?.exit_code ?? null,
							output: result.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
							logBytes: tracked.log.retainedBytes(),
						});
						return { result };
					},
					(error: unknown) => {
						collecting = false;
						const reason = captureError ?? error;
						const message = reason instanceof Error ? reason.message : String(reason);
						tracked.finish({
							status: captureError
								? "failed"
								: stopped || controller.signal.aborted
									? "stopped"
									: message.includes("Command timed out after")
										? "timed_out"
										: "failed",
							exitCode: null,
							output: message,
							logBytes: tracked.log.retainedBytes(),
						});
						return { error: reason };
					},
				);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				let outcome = await Promise.race([
					completion,
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => resolve(undefined), foregroundWaitMs);
					}),
				]);
				if (outcome === undefined && controller.signal.aborted) outcome = await completion;
				if (outcome !== undefined) {
					tracked.release();
					if ("error" in outcome) throw outcome.error;
					return outcome.result;
				}
				promoted = true;
				tracked.promote();
				const text = `Process ${tracked.id} is still running. Completion will be notified automatically; continue independent work or end this turn. Use process_control to search logs, stop it, or wait when the next step depends on it.`;
				return {
					content: [{ type: "text" as const, text }],
					details: undefined,
					structuredContent: {
						status: "running" as const,
						process_id: tracked.id,
						output: tracked.log.tail(),
						wall_time_seconds: (Date.now() - started) / 1_000,
					},
				};
			} finally {
				if (timer) clearTimeout(timer);
				// After handoff the process belongs to process_control, not the completed tool call.
				signal?.removeEventListener("abort", abort);
			}
		},
	};
}
