import { type AuthInteraction, createModels, type OAuthAuth, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type AccountStore, PROVIDER } from "./store.js";
import { consumeReset, fetchUsage } from "./usage.js";

export const PERSONAL_PROVIDER = "codex-accounts";

// Pi 0.87's extension loader explicitly supports providers/all, not individual provider subpaths.
function codexProvider(): Provider {
	const provider = builtinProviders().find((p) => p.id === PROVIDER);
	if (!provider) throw new Error("Provider Codex não disponível nesta versão do Pi.");
	return provider;
}

export class AccountService {
	readonly store: AccountStore;
	private readonly base: Provider;
	constructor(store: AccountStore, base: Provider = codexProvider()) {
		this.store = store;
		this.base = base;
	}

	async login(label: string, interaction: AuthInteraction): Promise<void> {
		const oauth = this.base.auth.oauth as OAuthAuth;
		const credential = await oauth.login({
			...interaction,
			signal: interaction.signal ?? AbortSignal.timeout(5 * 60_000),
		});
		await this.store.add(label, credential);
	}

	private async auth(id: string, signal: AbortSignal) {
		const models = createModels({ credentials: this.store.credentials(id) });
		models.setProvider(this.base);
		try {
			const result = await models.getAuth(PROVIDER, { signal });
			if (!result?.auth.apiKey) throw new Error("Missing auth");
			return result;
		} catch {
			// Provider errors may contain token endpoint bodies. Never surface those to the UI/model.
			throw new Error("Não foi possível autenticar a conta selecionada. Abra /codex-accounts.");
		}
	}

	async usage(id: string, signal: AbortSignal) {
		const auth = await this.auth(id, signal);
		return fetchUsage(auth.auth.apiKey as string, id, signal);
	}

	async reset(id: string, signal: AbortSignal) {
		const auth = await this.auth(id, signal);
		return consumeReset(auth.auth.apiKey as string, id, signal);
	}

	/** Separate provider ID avoids touching or refreshing Pi's default auth.json credentials.
	 * An unbound provider exposes the catalog for startup restoration, but cannot send requests.
	 */
	provider(id: string | undefined): Provider {
		return {
			...this.base,
			id: PERSONAL_PROVIDER,
			name: "Codex · contas pessoais",
			getModels: () => this.base.getModels().map((model) => ({ ...model, provider: PERSONAL_PROVIDER })),
			auth: {
				apiKey: {
					name: "Codex account vault",
					check: async () => ({ type: "oauth", source: "OAuth" }),
					resolve: ({ signal }) => {
						if (!id) throw new Error("Selecione uma conta em /codex-accounts antes de continuar.");
						return this.auth(id, signal);
					},
				},
			},
		};
	}
}
