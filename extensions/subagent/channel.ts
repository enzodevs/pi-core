import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ChildLineage } from "./protocol.ts";

const CHANNEL_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export interface ChannelMetadata {
	version: 1;
	token: string;
	runId: string;
	lineage: ChildLineage;
	createdAt: number;
}

export interface ChannelQuestion {
	version: 1;
	token: string;
	id: string;
	text: string;
	askedAt: number;
}

export type ChannelCommand =
	| { version: 1; token: string; id: string; type: "message"; text: string; createdAt: number }
	| {
			version: 1;
			token: string;
			id: string;
			type: "reply";
			questionId: string;
			text: string;
			createdAt: number;
	  }
	| { version: 1; token: string; id: string; type: "cancel"; createdAt: number };

export interface ChannelResult {
	version: 1;
	token: string;
	status: "complete" | "failed" | "stopped";
	output: string;
	finishedAt: number;
}

export interface ChannelExit {
	version: 1;
	token: string;
	code: number;
}

export interface SidecarChannel {
	directory: string;
	token: string;
	metadata: ChannelMetadata;
}

function randomToken(bytes = 18): string {
	return randomBytes(bytes).toString("base64url");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	const temporary = `${filePath}.tmp-${process.pid}-${randomToken(6)}`;
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: FILE_MODE });
	fs.renameSync(temporary, filePath);
}

function writeJsonOnce(filePath: string, value: unknown): boolean {
	const temporary = `${filePath}.tmp-${process.pid}-${randomToken(6)}`;
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: FILE_MODE });
	try {
		fs.linkSync(temporary, filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function readJson(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function isPrivateDirectory(directory: string): boolean {
	try {
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		if (process.platform !== "win32" && stat.uid !== process.getuid?.()) return false;
		return process.platform === "win32" || (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function metadataPath(directory: string): string {
	return path.join(directory, "metadata.json");
}

function commandsPath(directory: string): string {
	return path.join(directory, "commands");
}

function acknowledgementsPath(directory: string): string {
	return path.join(directory, "acks");
}

export function createSidecarChannel(params: { runRoot?: string; lineage: ChildLineage }): SidecarChannel {
	const root = params.runRoot ?? path.join(getAgentDir(), "pi-core", "subagents", "runs");
	fs.mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
	const directory = fs.mkdtempSync(path.join(root, `${params.lineage.runId}-`));
	fs.chmodSync(directory, DIRECTORY_MODE);
	fs.mkdirSync(commandsPath(directory), { mode: DIRECTORY_MODE });
	fs.mkdirSync(acknowledgementsPath(directory), { mode: DIRECTORY_MODE });
	const token = randomToken();
	const metadata: ChannelMetadata = {
		version: CHANNEL_VERSION,
		token,
		runId: params.lineage.runId,
		lineage: params.lineage,
		createdAt: Date.now(),
	};
	writeJsonAtomic(metadataPath(directory), metadata);
	return { directory, token, metadata };
}

export function openSidecarChannel(params: {
	directory: string;
	token: string;
	lineage: ChildLineage;
}): SidecarChannel {
	if (!path.isAbsolute(params.directory) || !isPrivateDirectory(params.directory)) {
		throw new Error("Unsafe subagent sidecar directory.");
	}
	const value = readJson(metadataPath(params.directory));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Missing subagent sidecar metadata.");
	}
	const metadata = value as Partial<ChannelMetadata>;
	if (
		metadata.version !== CHANNEL_VERSION ||
		metadata.token !== params.token ||
		metadata.runId !== params.lineage.runId ||
		metadata.lineage?.runId !== params.lineage.runId ||
		metadata.lineage?.rootRunId !== params.lineage.rootRunId ||
		metadata.lineage?.parentRunId !== params.lineage.parentRunId
	) {
		throw new Error("Subagent sidecar ownership mismatch.");
	}
	return { directory: params.directory, token: params.token, metadata: metadata as ChannelMetadata };
}

export function publishQuestion(
	channel: SidecarChannel,
	question: Omit<ChannelQuestion, "version" | "token">,
): void {
	writeJsonAtomic(path.join(channel.directory, "question.json"), {
		version: CHANNEL_VERSION,
		token: channel.token,
		...question,
	} satisfies ChannelQuestion);
}

export function readQuestion(channel: SidecarChannel): ChannelQuestion | undefined {
	const value = readJson(path.join(channel.directory, "question.json"));
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const question = value as Partial<ChannelQuestion>;
	return question.version === CHANNEL_VERSION &&
		question.token === channel.token &&
		typeof question.id === "string" &&
		typeof question.text === "string" &&
		typeof question.askedAt === "number"
		? (question as ChannelQuestion)
		: undefined;
}

export function clearQuestion(channel: SidecarChannel, questionId: string): void {
	const question = readQuestion(channel);
	if (question?.id !== questionId) return;
	fs.rmSync(path.join(channel.directory, "question.json"), { force: true });
}

export function publishResult(
	channel: SidecarChannel,
	result: Omit<ChannelResult, "version" | "token">,
): boolean {
	return writeJsonOnce(path.join(channel.directory, "result.json"), {
		version: CHANNEL_VERSION,
		token: channel.token,
		...result,
	} satisfies ChannelResult);
}

export function readResult(channel: SidecarChannel): ChannelResult | undefined {
	const value = readJson(path.join(channel.directory, "result.json"));
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result = value as Partial<ChannelResult>;
	return result.version === CHANNEL_VERSION &&
		result.token === channel.token &&
		(result.status === "complete" || result.status === "failed" || result.status === "stopped") &&
		typeof result.output === "string" &&
		typeof result.finishedAt === "number"
		? (result as ChannelResult)
		: undefined;
}

export function readExit(channel: SidecarChannel): ChannelExit | undefined {
	const value = readJson(path.join(channel.directory, "exit.json"));
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const exit = value as Partial<ChannelExit>;
	return exit.version === CHANNEL_VERSION && exit.token === channel.token && Number.isInteger(exit.code)
		? (exit as ChannelExit)
		: undefined;
}

export function writeCommand(
	channel: SidecarChannel,
	command:
		| { type: "message"; text: string }
		| { type: "reply"; questionId: string; text: string }
		| { type: "cancel" },
): string {
	const order = process.hrtime.bigint().toString().padStart(20, "0");
	const id = `${order}-${randomToken(8)}`;
	const value = {
		version: CHANNEL_VERSION,
		token: channel.token,
		id,
		...command,
		createdAt: Date.now(),
	} as ChannelCommand;
	writeJsonAtomic(path.join(commandsPath(channel.directory), `${id}.json`), value);
	return id;
}

export function listPendingCommands(channel: SidecarChannel): ChannelCommand[] {
	let names: string[];
	try {
		names = fs
			.readdirSync(commandsPath(channel.directory))
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
	const commands: ChannelCommand[] = [];
	for (const name of names) {
		const id = name.slice(0, -5);
		if (fs.existsSync(path.join(acknowledgementsPath(channel.directory), `${id}.json`))) continue;
		const value = readJson(path.join(commandsPath(channel.directory), name));
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const command = value as Partial<ChannelCommand>;
		if (
			command.version !== CHANNEL_VERSION ||
			command.token !== channel.token ||
			command.id !== id ||
			(command.type !== "message" && command.type !== "reply" && command.type !== "cancel") ||
			typeof command.createdAt !== "number"
		) {
			continue;
		}
		if ((command.type === "message" || command.type === "reply") && typeof command.text !== "string")
			continue;
		if (command.type === "reply" && typeof command.questionId !== "string") continue;
		commands.push(command as ChannelCommand);
	}
	return commands;
}

export function acknowledgeCommand(channel: SidecarChannel, commandId: string): void {
	writeJsonAtomic(path.join(acknowledgementsPath(channel.directory), `${commandId}.json`), {
		version: CHANNEL_VERSION,
		token: channel.token,
		id: commandId,
		acknowledgedAt: Date.now(),
	});
}

export function watchSidecar(channel: SidecarChannel, onChange: () => void): () => void {
	let queued = false;
	const notify = () => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			onChange();
		});
	};
	const watchers = [channel.directory, commandsPath(channel.directory)].map((directory) =>
		fs.watch(directory, { persistent: false }, notify),
	);
	return () => {
		for (const watcher of watchers) watcher.close();
	};
}

export function removeSidecar(channel: SidecarChannel): void {
	fs.rmSync(channel.directory, { recursive: true, force: true });
}
