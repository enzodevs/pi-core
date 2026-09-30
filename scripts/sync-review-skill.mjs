#!/usr/bin/env node
// The shared skill is authored outside this repo; the packaged copy is generated.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../extensions/subagent/reviewer-skill/", import.meta.url));
const manifestName = "source-manifest.json";

async function runtimeFiles(root) {
	const files = ["SKILL.md"];
	for (const directory of ["references", "scripts"]) {
		for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(directory === "scripts" ? ".py" : ".md")) {
				files.push(`${directory}/${entry.name}`);
			}
		}
	}
	return files.sort();
}

async function digest(root) {
	const entries = [];
	for (const file of await runtimeFiles(root)) {
		entries.push([
			file,
			createHash("sha256")
				.update(await readFile(path.join(root, file)))
				.digest("hex"),
		]);
	}
	const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
	const version = skill.match(/^ {2}version: (.+)$/m)?.[1];
	if (!version) throw new Error("SKILL.md metadata.version is required");
	return { schema_version: 1, skill_version: version, files: Object.fromEntries(entries) };
}

async function main() {
	let source;
	let write = false;
	for (let index = 2; index < process.argv.length; index++) {
		const argument = process.argv[index];
		if (argument === "--source") {
			source = process.argv[++index];
			if (!source || source.startsWith("--")) throw new Error("--source requires a path");
		} else if (argument === "--write") write = true;
		else if (argument !== "--check") {
			throw new Error("Usage: node scripts/sync-review-skill.mjs [--check | --write] [--source PATH]");
		}
	}
	if (write && !source) throw new Error("--write requires --source pointing to the authoritative skill");
	if (write) {
		const expected = await digest(source);
		const stale = (await runtimeFiles(destination)).filter((file) => !(file in expected.files));
		if (stale.length) throw new Error(`Review stale vendored files before syncing: ${stale.join(", ")}`);
		for (const file of Object.keys(expected.files)) {
			const target = path.join(destination, file);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, await readFile(path.join(source, file)));
		}
		await writeFile(path.join(destination, manifestName), `${JSON.stringify(expected, null, "\t")}\n`);
	}
	const recorded = JSON.parse(await readFile(path.join(destination, manifestName), "utf8"));
	const actual = await digest(destination);
	if (JSON.stringify(recorded) !== JSON.stringify(actual)) {
		throw new Error("Vendored review skill drifted; regenerate it from the authoritative source");
	}
	if (source && JSON.stringify(await digest(source)) !== JSON.stringify(actual)) {
		throw new Error("Authoritative skill differs from vendored copy; sync with --write --source PATH");
	}
	console.log(
		`Review skill ${actual.skill_version}: ${Object.keys(actual.files).length} runtime files verified`,
	);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
