import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getStoragePaths } from "../skill-manager/paths.js";
import { generateImage } from "./generate.js";

export default function imageGeneration(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate image",
		description: "Generate one PNG from a prompt using the ChatGPT subscription. Returns its local path.",
		exposure: "deferred",
		parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 16000 }) }),
		async execute(_id, { prompt }, signal) {
			const path = await generateImage(
				prompt,
				process.env.CODEX_HOME || join(homedir(), ".codex"),
				join(getStoragePaths().directory, "images"),
				signal,
			);
			return { content: [{ type: "text", text: path }], details: {} };
		},
	});
}
