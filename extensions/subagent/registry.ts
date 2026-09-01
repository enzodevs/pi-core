import * as fs from "node:fs";
import * as path from "node:path";

interface LeaseRecord {
	id: string;
	pid: number;
	startedAt: number;
}

interface LeaseState {
	version: 1;
	leases: LeaseRecord[];
}

export interface ConcurrencyLease {
	release(): Promise<void>;
}

export class GlobalConcurrencyLimitError extends Error {
	constructor(readonly limit: number) {
		super(`Global background-agent concurrency limit reached (${limit}).`);
		this.name = "GlobalConcurrencyLimitError";
	}
}

export interface ConcurrencyRegistryOptions {
	filePath: string;
	limit: number;
	pid?: number;
	now?: () => number;
	isPidAlive?: (pid: number) => boolean;
	lockTimeoutMs?: number;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GlobalConcurrencyRegistry {
	private readonly filePath: string;
	private readonly lockPath: string;
	private readonly limit: number;
	private readonly pid: number;
	private readonly now: () => number;
	private readonly isPidAlive: (pid: number) => boolean;
	private readonly lockTimeoutMs: number;

	constructor(options: ConcurrencyRegistryOptions) {
		this.filePath = options.filePath;
		this.lockPath = `${options.filePath}.lock`;
		this.limit = options.limit;
		this.pid = options.pid ?? process.pid;
		this.now = options.now ?? (() => Date.now());
		this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
		this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
	}

	async claim(id: string): Promise<ConcurrencyLease> {
		return this.claimInternal(id, false);
	}

	/** Reclaim a live tmux child after extension reload or parent-process restart. */
	async adopt(id: string): Promise<ConcurrencyLease> {
		return this.claimInternal(id, true);
	}

	async capacity(): Promise<{ active: number; limit: number; available: number }> {
		return this.withLock(async () => {
			const state = await this.readState();
			state.leases = state.leases.filter((lease) => this.isPidAlive(lease.pid));
			await this.writeState(state);
			return {
				active: state.leases.length,
				limit: this.limit,
				available: Math.max(0, this.limit - state.leases.length),
			};
		});
	}

	private async claimInternal(id: string, adoptOwned: boolean): Promise<ConcurrencyLease> {
		await this.withLock(async () => {
			const state = await this.readState();
			state.leases = state.leases.filter((lease) => this.isPidAlive(lease.pid));
			const existing = state.leases.find((lease) => lease.id === id);
			if (existing) {
				if (!adoptOwned || existing.pid !== this.pid) throw new Error(`Duplicate agent run: ${id}.`);
				return;
			}
			if (state.leases.length >= this.limit) {
				throw new GlobalConcurrencyLimitError(this.limit);
			}
			state.leases.push({ id, pid: this.pid, startedAt: this.now() });
			await this.writeState(state);
		});

		let released = false;
		return {
			release: async () => {
				if (released) return;
				released = true;
				await this.withLock(async () => {
					const state = await this.readState();
					state.leases = state.leases.filter((lease) => lease.id !== id);
					await this.writeState(state);
				});
			},
		};
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const startedAt = this.now();
		while (true) {
			try {
				await fs.promises.mkdir(this.lockPath, { mode: 0o700 });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const stat = await fs.promises.stat(this.lockPath);
					if (this.now() - stat.mtimeMs > 10_000) {
						await fs.promises.rm(this.lockPath, { recursive: true, force: true });
						continue;
					}
				} catch {
					continue;
				}
				if (this.now() - startedAt >= this.lockTimeoutMs) {
					throw new Error("Timed out acquiring the background-agent concurrency lock.");
				}
				await delay(20);
			}
		}
		try {
			return await operation();
		} finally {
			await fs.promises.rm(this.lockPath, { recursive: true, force: true });
		}
	}

	private async readState(): Promise<LeaseState> {
		try {
			const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<LeaseState>;
			if (parsed.version !== 1 || !Array.isArray(parsed.leases)) {
				throw new Error("Invalid background-agent concurrency registry.");
			}
			const leases = parsed.leases.filter(
				(item): item is LeaseRecord =>
					Boolean(item) &&
					typeof item.id === "string" &&
					Number.isInteger(item.pid) &&
					Number.isFinite(item.startedAt),
			);
			if (leases.length !== parsed.leases.length) {
				throw new Error("Invalid lease in the background-agent concurrency registry.");
			}
			return { version: 1, leases };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, leases: [] };
			throw new Error("Cannot read the background-agent concurrency registry safely.", { cause: error });
		}
	}

	private async writeState(state: LeaseState): Promise<void> {
		const temporary = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
		await fs.promises.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(temporary, this.filePath);
	}
}
