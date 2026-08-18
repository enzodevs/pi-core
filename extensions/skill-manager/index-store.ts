import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IndexedSkill } from "./types.js";

interface PersistedIndex {
	version: 1;
	projects: Record<string, { updatedAt: string; skills: IndexedSkill[] }>;
}

const EMPTY_INDEX: PersistedIndex = { version: 1, projects: {} };

export class SkillIndexStore {
	private data: PersistedIndex = structuredClone(EMPTY_INDEX);
	constructor(private readonly path: string) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as PersistedIndex;
			if (parsed.version === 1 && parsed.projects && typeof parsed.projects === "object") this.data = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	get(cwd: string): readonly IndexedSkill[] {
		return this.data.projects[resolve(cwd)]?.skills ?? [];
	}

	async update(cwd: string, skills: readonly IndexedSkill[]): Promise<void> {
		const key = resolve(cwd);
		this.data.projects[key] = { updatedAt: new Date().toISOString(), skills: [...skills] };
		await mkdir(dirname(this.path), { recursive: true });
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
		await rename(temporaryPath, this.path);
	}
}
