import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ARTIFACT_THRESHOLD_BYTES,
	ArtifactStore,
	LOOKUP_MAX_BYTES,
} from "../extensions/context-guard/artifacts.js";

const roots: string[] = [];
const temporaryFiles: string[] = [];
const originalTmpdir = process.env.TMPDIR;

function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-artifacts-test-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
	for (const value of temporaryFiles.splice(0)) fs.rmSync(value, { force: true });
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
});

describe("context artifact store", () => {
	it("ignores small ordinary results and privately stores oversized output", () => {
		const directory = root();
		const store = new ArtifactStore({ root: directory });
		expect(
			store.store({ toolCallId: "small", toolName: "bash", sessionId: "s1", content: "ok" }),
		).toBeUndefined();
		const artifact = store.store({
			toolCallId: "large",
			toolName: "bash",
			sessionId: "s1",
			content: `start\n${"noise\n".repeat(ARTIFACT_THRESHOLD_BYTES)}FATAL database migration failed\nend`,
		});

		expect(artifact?.metadata.id).toMatch(/^[a-f0-9]{16}$/);
		expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
		expect(fs.statSync(artifact?.path ?? "").mode & 0o777).toBe(0o600);
	});

	it("searches exact session-owned artifacts with bounded line-numbered context", () => {
		const store = new ArtifactStore({ root: root() });
		const artifact = store.store({
			toolCallId: "call-1",
			toolName: "bash",
			sessionId: "session-a",
			content: `${"noise\n".repeat(2000)}src/store.ts:42 TS2322 migration failed\ncontext line`,
		});
		const result = store.search(artifact?.metadata.id ?? "", "session-a", "store.ts TS2322", 5);

		expect(result?.matches).toBe(1);
		expect(result?.text).toContain("src/store.ts:42 TS2322 migration failed");
		expect(Buffer.byteLength(result?.text ?? "")).toBeLessThanOrEqual(LOOKUP_MAX_BYTES);
		expect(store.search(artifact?.metadata.id ?? "", "other-session", "store.ts")).toBeUndefined();
	});

	it("ranks multi-term matches while including useful partial matches", () => {
		const store = new ArtifactStore({ root: root() });
		const artifact = store.store({
			toolCallId: "call-ranked",
			toolName: "bash",
			sessionId: "s1",
			content: `${"noise\n".repeat(2000)}Grafana dashboards\nunrelated\nOpenTelemetry Collector exports traces\nOpenTelemetry SDK setup`,
		});
		const result = store.search(artifact?.metadata.id ?? "", "s1", "OpenTelemetry Collector traces", 2);

		expect(result?.matches).toBe(2);
		expect(result?.text).toContain("ranked; partial term matches included");
		expect(result?.text).toContain("OpenTelemetry Collector exports traces");
		expect(result?.text).toContain("OpenTelemetry SDK setup");
		expect(result?.text).not.toContain("Grafana dashboards");
	});

	it("preserves source order when equally ranked lines are returned", () => {
		const store = new ArtifactStore({ root: root() });
		const artifact = store.store({
			toolCallId: "call-ranked-order",
			toolName: "bash",
			sessionId: "s1",
			content: `${"noise\n".repeat(2000)}alpha first\nunrelated\nbeta second`,
		});
		const result = store.search(artifact?.metadata.id ?? "", "s1", "alpha beta");

		expect(result?.matches).toBe(2);
		expect(result?.text.indexOf("alpha first")).toBeLessThan(result?.text.indexOf("beta second") ?? 0);
	});

	it("centers bounded snippets around matches inside huge single lines", () => {
		const store = new ArtifactStore({ root: root() });
		const artifact = store.store({
			toolCallId: "call-long-line",
			toolName: "bash",
			sessionId: "s1",
			content: `${"x".repeat(12_000)}UNIQUE_NEEDLE${"y".repeat(12_000)}`,
		});
		const result = store.search(artifact?.metadata.id ?? "", "s1", "UNIQUE_NEEDLE");

		expect(result?.text).toContain("UNIQUE_NEEDLE");
		expect(Buffer.byteLength(result?.text ?? "")).toBeLessThanOrEqual(LOOKUP_MAX_BYTES);
	});

	it("copies provenance-bound Pi full output before its temporary file disappears", () => {
		const directory = root();
		const source = path.join(os.tmpdir(), "pi-bash-0123456789abcdef.log");
		temporaryFiles.push(source);
		fs.writeFileSync(source, `${"full output\n".repeat(2000)}FINAL_FAILURE\n`, { mode: 0o600 });
		const store = new ArtifactStore({ root: path.join(directory, "store") });
		const artifact = store.store({
			toolCallId: "call-full",
			toolName: "bash",
			sessionId: "s1",
			content: "Pi bounded tail",
			fullOutputPath: source,
		});
		fs.rmSync(source);

		expect(store.search(artifact?.metadata.id ?? "", "s1", "FINAL_FAILURE")?.matches).toBe(1);
	});

	it("accepts Pi output beneath a symlinked temporary root", () => {
		const directory = root();
		const actualTmpdir = path.join(directory, "actual-tmp");
		const linkedTmpdir = path.join(directory, "linked-tmp");
		fs.mkdirSync(actualTmpdir);
		fs.symlinkSync(actualTmpdir, linkedTmpdir);
		process.env.TMPDIR = linkedTmpdir;
		const source = path.join(linkedTmpdir, "pi-bash-1122334455667788.log");
		fs.writeFileSync(source, `${"full output\n".repeat(2000)}SYMLINK_TMP_OK\n`, { mode: 0o600 });
		const store = new ArtifactStore({ root: path.join(directory, "store") });
		const artifact = store.store({
			toolCallId: "symlink-tmp",
			toolName: "bash",
			sessionId: "s1",
			content: "Pi bounded tail",
			fullOutputPath: source,
		});

		expect(store.search(artifact?.metadata.id ?? "", "s1", "SYMLINK_TMP_OK")?.matches).toBe(1);
	});

	it("rejects arbitrary and symlinked full-output paths", () => {
		const directory = root();
		const arbitrary = path.join(directory, "secret.txt");
		const piNamedSymlink = path.join(os.tmpdir(), "pi-bash-fedcba9876543210.log");
		temporaryFiles.push(piNamedSymlink);
		fs.writeFileSync(arbitrary, `${"secret\n".repeat(2000)}DO_NOT_INDEX`);
		fs.symlinkSync(arbitrary, piNamedSymlink);
		const store = new ArtifactStore({ root: path.join(directory, "store") });

		expect(
			store.store({
				toolCallId: "arbitrary",
				toolName: "bash",
				sessionId: "s1",
				content: "small",
				fullOutputPath: arbitrary,
			}),
		).toBeUndefined();
		expect(
			store.store({
				toolCallId: "symlink",
				toolName: "bash",
				sessionId: "s1",
				content: "small",
				fullOutputPath: piNamedSymlink,
			}),
		).toBeUndefined();
	});

	it("enforces its byte cap after malformed UTF-8 decoding", () => {
		const source = path.join(os.tmpdir(), "pi-bash-aabbccddeeff0011.log");
		temporaryFiles.push(source);
		fs.writeFileSync(source, Buffer.alloc(16_000, 0xff), { mode: 0o600 });
		const store = new ArtifactStore({ root: root(), maxArtifactBytes: 1024 });
		const artifact = store.store({
			toolCallId: "malformed",
			toolName: "bash",
			sessionId: "s1",
			content: "bounded fallback",
			fullOutputPath: source,
		});

		expect(artifact?.metadata.storedBytes).toBeLessThanOrEqual(1024);
		expect(artifact?.metadata.truncated).toBe(true);
	});

	it("enforces TTL during lookup without requiring another write", () => {
		let now = 1_000;
		const store = new ArtifactStore({ root: root(), ttlMs: 100, now: () => now });
		const artifact = store.store({
			toolCallId: "lazy-expiry",
			toolName: "bash",
			sessionId: "s1",
			content: `needle\n${"x".repeat(ARTIFACT_THRESHOLD_BYTES)}`,
		});
		now += 200;

		expect(store.search(artifact?.metadata.id ?? "", "s1", "needle")).toBeUndefined();
		expect(fs.existsSync(artifact?.path ?? "")).toBe(false);
	});

	it("reconciles stale temporary and invalid artifact files", () => {
		const directory = root();
		const temporary = path.join(directory, "interrupted-output.tmp");
		const invalid = path.join(directory, "orphan.artifact");
		fs.writeFileSync(temporary, "sensitive partial output");
		fs.writeFileSync(invalid, "not metadata\nsensitive output");
		fs.utimesSync(temporary, new Date(0), new Date(0));
		new ArtifactStore({ root: directory, now: () => 2 * 60 * 60 * 1000 });

		expect(fs.existsSync(temporary)).toBe(false);
		expect(fs.existsSync(invalid)).toBe(false);
	});

	it("removes expired and over-budget artifacts", () => {
		let now = 1_000;
		const store = new ArtifactStore({ root: root(), ttlMs: 100, maxStoreBytes: 20_000, now: () => now });
		const first = store.store({
			toolCallId: "first",
			toolName: "bash",
			sessionId: "s1",
			content: `first\n${"a".repeat(ARTIFACT_THRESHOLD_BYTES)}`,
		});
		now += 200;
		store.cleanup();

		expect(store.get(first?.metadata.id ?? "", "s1")).toBeUndefined();
	});
});
