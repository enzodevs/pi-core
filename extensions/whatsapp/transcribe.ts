import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { delimiter, join, parse } from "node:path";

const MAX_PROCESS_OUTPUT_BYTES = 8_192;
const MAX_TRANSCRIPT_CHARACTERS = 12_000;

async function executable(name: string): Promise<string | undefined> {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	return undefined;
}

async function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const collect = (chunk: Buffer) => {
			if (Buffer.byteLength(output) < MAX_PROCESS_OUTPUT_BYTES) output += chunk.toString("utf8");
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.once("error", reject);
		child.once("close", (code) => {
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) return reject(new Error("Transcription aborted"));
			if (code === 0) return resolve();
			reject(new Error(`Transcriber exited ${code}: ${output.trim().slice(-2_000)}`));
		});
	});
}

export interface Transcriber {
	name: string;
	transcribe(input: string, outputDirectory: string, signal?: AbortSignal): Promise<string>;
}

function srtToText(contents: string): string {
	return contents
		.split("\n")
		.filter((line) => !/^\d+$/.test(line.trim()) && !line.includes(" --> "))
		.join(" ");
}

export async function discoverTranscriber(): Promise<Transcriber | undefined> {
	const fasterWhisper = await executable("faster-whisper");
	if (fasterWhisper) {
		return {
			name: "faster-whisper",
			async transcribe(input, outputDirectory, signal) {
				const output = join(outputDirectory, `${parse(input).name}.srt`);
				await run(
					fasterWhisper,
					[
						input,
						"--output",
						output,
						"--language",
						process.env.PI_WPP_WHISPER_LANGUAGE ?? "pt",
						"--model_size_or_path",
						process.env.PI_WPP_WHISPER_MODEL ?? "small",
						"--local_files_only",
						"True",
					],
					signal,
				);
				return srtToText(await readFile(output, "utf8"));
			},
		};
	}
	const whisper = await executable("whisper");
	if (whisper) {
		return {
			name: "whisper",
			async transcribe(input, outputDirectory, signal) {
				await run(
					whisper,
					[
						input,
						"--output_dir",
						outputDirectory,
						"--output_format",
						"txt",
						"--model",
						process.env.PI_WPP_WHISPER_MODEL ?? "base",
					],
					signal,
				);
				return readFile(join(outputDirectory, `${parse(input).name}.txt`), "utf8");
			},
		};
	}
	const whisperCli = await executable("whisper-cli");
	const model = process.env.PI_WPP_WHISPER_MODEL_PATH;
	if (whisperCli && model) {
		return {
			name: "whisper-cli",
			async transcribe(input, outputDirectory, signal) {
				const outputBase = join(outputDirectory, parse(input).name);
				await run(whisperCli, ["-m", model, "-f", input, "-otxt", "-of", outputBase], signal);
				return readFile(`${outputBase}.txt`, "utf8");
			},
		};
	}
	return undefined;
}

export function boundedTranscript(text: string): { text: string; truncated: boolean } {
	const normalized = text.replaceAll(/\s+/g, " ").trim();
	if (normalized.length <= MAX_TRANSCRIPT_CHARACTERS) return { text: normalized, truncated: false };
	return { text: `${normalized.slice(0, MAX_TRANSCRIPT_CHARACTERS)}…`, truncated: true };
}

export async function removePrivateTranscriptionDirectory(path: string): Promise<void> {
	await rm(path, { force: true, recursive: true });
}
