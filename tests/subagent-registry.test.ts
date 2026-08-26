import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalConcurrencyRegistry } from "../extensions/subagent/registry.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function registry(limit: number, pid = 100): GlobalConcurrencyRegistry {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-registry-test-"));
	roots.push(root);
	return new GlobalConcurrencyRegistry({
		filePath: path.join(root, "concurrency.json"),
		limit,
		pid,
		isPidAlive: () => true,
	});
}

describe("global subagent concurrency registry", () => {
	it("enforces the shared cap and releases capacity idempotently", async () => {
		const store = registry(2);
		const first = await store.claim("first");
		const second = await store.claim("second");
		await expect(store.claim("third")).rejects.toThrow("concurrency limit");
		await first.release();
		await first.release();
		const third = await store.claim("third");
		await Promise.all([second.release(), third.release()]);
	});

	it("prunes a lease whose owner process is gone", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-registry-test-"));
		roots.push(root);
		const filePath = path.join(root, "concurrency.json");
		const oldStore = new GlobalConcurrencyRegistry({
			filePath,
			limit: 1,
			pid: 111,
			isPidAlive: () => true,
		});
		await oldStore.claim("orphan");
		const nextStore = new GlobalConcurrencyRegistry({
			filePath,
			limit: 1,
			pid: 222,
			isPidAlive: (pid) => pid === 222,
		});
		const lease = await nextStore.claim("replacement");
		await lease.release();
	});

	it("fails closed on corrupt shared state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-registry-test-"));
		roots.push(root);
		const filePath = path.join(root, "concurrency.json");
		fs.writeFileSync(filePath, "not json", "utf8");
		const store = new GlobalConcurrencyRegistry({ filePath, limit: 2, isPidAlive: () => true });
		await expect(store.claim("run")).rejects.toThrow("Cannot read");
	});
});
