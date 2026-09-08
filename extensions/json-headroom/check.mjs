import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getHeadroomPaths } from "./paths.mjs";

const python = process.env.PI_CORE_HEADROOM_PYTHON || getHeadroomPaths().python;
const checks = [
	[python, ["-I", fileURLToPath(new URL("../../tests/test_json_headroom.py", import.meta.url))]],
	[
		process.execPath,
		[
			fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
			"run",
			"tests/json-headroom-integration.test.ts",
		],
	],
];
for (const [command, args] of checks) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: { ...process.env, PI_CORE_HEADROOM_PYTHON: python },
	});
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
