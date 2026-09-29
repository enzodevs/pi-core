import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-core-compat-latest-"));
const keepTemporary = process.env.PI_CORE_KEEP_COMPAT_TEMP === "1";
const piPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: temporaryRoot,
		stdio: "inherit",
		env: { ...process.env, CI: "1" },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exitCode = result.status ?? 1;
	return result.status === 0;
}

try {
	cpSync(projectRoot, temporaryRoot, {
		recursive: true,
		filter(source) {
			const relative = source.slice(projectRoot.length + 1);
			return ![".git", "node_modules"].some(
				(ignored) => relative === ignored || relative.startsWith(`${ignored}/`),
			);
		},
	});

	const manifestPath = join(temporaryRoot, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	for (const packageName of piPackages) manifest.devDependencies[packageName] = "latest";
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	rmSync(join(temporaryRoot, "package-lock.json"), { force: true });

	console.log(`Checking pi-core against the latest Pi packages in ${temporaryRoot}`);
	if (
		run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]) &&
		run("npm", ["run", "typecheck"]) &&
		run("npm", ["test"]) &&
		run("npm", ["pack", "--dry-run"])
	) {
		run("npm", ["run", "compat:package"]);
	}
} finally {
	if (keepTemporary) console.log(`Preserved compatibility workspace: ${temporaryRoot}`);
	else rmSync(temporaryRoot, { recursive: true, force: true });
}
