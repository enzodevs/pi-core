import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

interface PackageManifest {
	pi?: { extensions?: string[] };
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function configuredExtensionPaths(): Promise<string[]> {
	const manifest = JSON.parse(
		await readFile(resolve(projectRoot, "package.json"), "utf8"),
	) as PackageManifest;
	return (manifest.pi?.extensions ?? []).map((extensionPath) => resolve(projectRoot, extensionPath));
}

describe("Pi extension compatibility", () => {
	it("loads every configured extension through Pi's public loader", async () => {
		const paths = [
			...(await configuredExtensionPaths()),
			resolve(projectRoot, "extensions/codex-accounts/index.ts"),
		];
		expect(paths.length).toBeGreaterThan(0);

		const agentDirectory = await mkdtemp(join(tmpdir(), "pi-core-loader-test-"));
		try {
			const result = await discoverAndLoadExtensions(paths, projectRoot, agentDirectory);

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(paths.length);
			expect(result.extensions.map((extension) => extension.resolvedPath)).toEqual(
				expect.arrayContaining(paths),
			);
		} finally {
			await rm(agentDirectory, { recursive: true, force: true });
		}
	});
});
