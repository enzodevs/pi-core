import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

export const PROVIDER = "openai-codex";
export interface Account {
	id: string;
	label: string;
	credential: OAuthCredential;
}
interface State {
	version: 1;
	accounts: Account[];
	piLabels?: Record<string, string>;
	defaultAccountId?: string;
}

export function normalizeLabel(value: string): string {
	const label = value.trim();
	if (!label || label.length > 60 || /[\p{Cc}\p{Cf}]/u.test(value))
		throw new Error("Nome inválido: use de 1 a 60 caracteres, sem controles.");
	return label;
}

function accountId(credential: OAuthCredential): string {
	if (typeof credential.accountId !== "string" || !credential.accountId) {
		throw new Error("Credencial Codex sem identificação de conta.");
	}
	return credential.accountId;
}

function parseState(text: string): State {
	const data = JSON.parse(text) as State;
	if (data?.version !== 1 || !Array.isArray(data.accounts)) throw new Error("Cofre inválido.");
	if (data.piLabels !== undefined) {
		if (!data.piLabels || typeof data.piLabels !== "object" || Array.isArray(data.piLabels))
			throw new Error("Apelidos inválidos.");
		for (const [id, label] of Object.entries(data.piLabels)) {
			if (!id || typeof label !== "string") throw new Error("Apelidos inválidos.");
			normalizeLabel(label);
		}
	}
	if (
		data.defaultAccountId !== undefined &&
		(typeof data.defaultAccountId !== "string" || !data.defaultAccountId)
	)
		throw new Error("Conta padrão inválida.");
	const ids = new Set<string>();
	for (const a of data.accounts) {
		if (
			!a ||
			typeof a.id !== "string" ||
			typeof a.label !== "string" ||
			!a.label.trim() ||
			a.label.length > 60 ||
			/[\p{Cc}\p{Cf}]/u.test(a.label) ||
			a.credential?.type !== "oauth" ||
			typeof a.credential.access !== "string" ||
			!a.credential.access ||
			typeof a.credential.refresh !== "string" ||
			!a.credential.refresh ||
			!Number.isFinite(a.credential.expires) ||
			accountId(a.credential) !== a.id ||
			ids.has(a.id)
		) {
			throw new Error("Cofre inválido.");
		}
		ids.add(a.id);
	}
	return data;
}

/** One cross-process lock covers mutations and token rotation. Secrets never leave via list(). */
export class AccountStore {
	private readonly path: string;
	constructor(private readonly directory: string) {
		this.path = join(directory, "accounts.json");
	}

	private async transaction<T>(
		fn: (state: State) => Promise<{ result: T; save?: boolean }>,
		signal?: AbortSignal,
	): Promise<T> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		if ((await lstat(this.directory)).isSymbolicLink())
			throw new Error("Diretório do cofre não pode ser symlink.");
		await chmod(this.directory, 0o700);
		signal?.throwIfAborted();
		let compromised: Error | undefined;
		const release = await lockfile.lock(this.path, {
			realpath: false,
			stale: 30_000,
			retries: { retries: 30, minTimeout: 50, maxTimeout: 1000 },
			onCompromised: (error) => {
				compromised = error;
			},
		});
		try {
			signal?.throwIfAborted();
			let state: State;
			try {
				if (!(await lstat(this.path)).isFile()) throw new Error("Cofre precisa ser arquivo regular.");
				await chmod(this.path, 0o600);
				state = parseState(await readFile(this.path, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				state = { version: 1, accounts: [] };
			}
			const { result, save } = await fn(state);
			// A completed refresh may already have rotated the server token. Persist it
			// even if the caller cancelled just after the exchange succeeded.
			if (compromised) throw compromised;
			if (save) {
				const temporary = `${this.path}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
					await rename(temporary, this.path);
				} finally {
					await rm(temporary, { force: true });
				}
			}
			return result;
		} finally {
			await release();
		}
	}

	list(): Promise<Array<Pick<Account, "id" | "label">>> {
		return this.transaction(async (state) => ({
			result: state.accounts.map(({ id, label }) => ({ id, label })),
		}));
	}

	defaultAccount(): Promise<string | undefined> {
		return this.transaction(async (state) => ({ result: state.defaultAccountId }));
	}

	async setDefaultAccount(id: string | undefined): Promise<void> {
		await this.transaction(async (state) => {
			if (id !== undefined && !state.accounts.some((account) => account.id === id))
				throw new Error("Conta removida; atualize o menu.");
			if (id === undefined) delete state.defaultAccountId;
			else state.defaultAccountId = id;
			return { result: undefined, save: true };
		});
	}

	async add(label: string, credential: OAuthCredential): Promise<void> {
		const account = { id: accountId(credential), label: normalizeLabel(label), credential };
		parseState(JSON.stringify({ version: 1, accounts: [account] }));
		await this.transaction(async (state) => {
			if (state.accounts.some((a) => a.id === account.id))
				throw new Error("Conta já cadastrada. Remova antes de autenticar novamente.");
			state.accounts.push(account);
			return { result: undefined, save: true };
		});
	}

	piLabel(id: string): Promise<string | undefined> {
		return this.transaction(async (state) => ({
			result: state.piLabels && Object.hasOwn(state.piLabels, id) ? state.piLabels[id] : undefined,
		}));
	}

	async rename(id: string, label: string, source: "pi" | "vault"): Promise<void> {
		const normalized = normalizeLabel(label);
		if (!id) throw new Error("Conta inválida.");
		await this.transaction(async (state) => {
			if (source === "pi") {
				// Only metadata for the host login: credentials remain owned by Pi.
				state.piLabels = { ...state.piLabels, [id]: normalized };
			} else {
				const account = state.accounts.find((a) => a.id === id);
				if (!account) throw new Error("Conta removida; atualize o menu.");
				account.label = normalized;
			}
			return { result: undefined, save: true };
		});
	}

	async remove(id: string): Promise<void> {
		await this.transaction(async (state) => {
			state.accounts = state.accounts.filter((a) => a.id !== id);
			if (state.defaultAccountId === id) delete state.defaultAccountId;
			return { result: undefined, save: true };
		});
	}

	credentials(id: string): CredentialStore {
		return {
			read: (_provider, options) =>
				this.transaction(
					async (s) => ({ result: s.accounts.find((a) => a.id === id)?.credential }),
					options?.signal,
				),
			list: async () =>
				(await this.list()).some((a) => a.id === id) ? [{ providerId: PROVIDER, type: "oauth" }] : [],
			modify: (_provider, fn, options) =>
				this.transaction(async (s) => {
					const account = s.accounts.find((a) => a.id === id);
					if (!account) throw new Error("Conta removida; selecione outra conta.");
					const next = await fn(account.credential);
					if (next) {
						if (next.type !== "oauth" || accountId(next) !== id)
							throw new Error("Identidade alterada durante renovação.");
						account.credential = next;
					}
					return { result: account.credential, save: !!next };
				}, options?.signal),
			delete: async () => {
				throw new Error("Use o menu para remover contas.");
			},
		};
	}
}
