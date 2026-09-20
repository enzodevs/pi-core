import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-core-package-smoke-"));
const packageDirectory = join(temporaryRoot, "package");
const consumerDirectory = join(temporaryRoot, "consumer");
const keepTemporary = process.env.PI_CORE_KEEP_COMPAT_TEMP === "1";
const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const piPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function run(cwd, command, args, capture = false) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: capture ? "utf8" : undefined,
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
	return capture ? result.stdout : "";
}

try {
	writeFileSync(join(temporaryRoot, ".keep"), "");
	rmSync(packageDirectory, { recursive: true, force: true });
	rmSync(consumerDirectory, { recursive: true, force: true });
	const packed = JSON.parse(
		run(projectRoot, "npm", ["pack", "--json", "--pack-destination", temporaryRoot], true),
	);
	const tarball = join(temporaryRoot, packed[0].filename);

	writeFileSync(join(temporaryRoot, "package.json"), JSON.stringify({ private: true, type: "module" }));
	const versions = piPackages.map((name) => {
		const configured = manifest.devDependencies[name];
		return `${name}@${configured.replace(/^[~^]/u, "")}`;
	});
	run(temporaryRoot, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...versions, tarball]);

	const smokePath = join(temporaryRoot, "smoke.mjs");
	writeFileSync(
		smokePath,
		`import { mkdtemp, readFile, rm } from "node:fs/promises";\n` +
			`import { tmpdir } from "node:os";\n` +
			`import { join, resolve } from "node:path";\n` +
			`import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";\n` +
			`const root = resolve("node_modules/@rrghost/pi-core");\n` +
			`const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));\n` +
			`const paths = manifest.pi.extensions.map((path) => resolve(root, path));\n` +
			`const agentDirectory = await mkdtemp(join(tmpdir(), "pi-core-package-loader-"));\n` +
			`try {\n` +
			`  const result = await discoverAndLoadExtensions(paths, process.cwd(), agentDirectory);\n` +
			`  if (result.errors.length || result.extensions.length !== paths.length) {\n` +
			`    console.error(JSON.stringify({ errors: result.errors, loaded: result.extensions.length, expected: paths.length }, null, 2));\n` +
			`    process.exitCode = 1;\n` +
			`  } else {\n` +
			`    console.log(\`Loaded \${result.extensions.length} extensions from ${basename(tarball)}\`);\n` +
			`  }\n` +
			`} finally {\n` +
			`  await rm(agentDirectory, { recursive: true, force: true });\n` +
			`}\n`,
	);
	run(temporaryRoot, process.execPath, [smokePath]);
} finally {
	if (keepTemporary) console.log(`Preserved package smoke workspace: ${temporaryRoot}`);
	else rmSync(temporaryRoot, { recursive: true, force: true });
}
