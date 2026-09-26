export interface UsageWindow {
	seconds: number;
	used: number;
	resetAt: number;
}
export interface Usage {
	windows: UsageWindow[];
	checkedAt: number;
	availableResets?: number;
}

export function parseUsage(value: unknown): Usage {
	const payload = value as {
		rate_limit?: unknown;
		rate_limit_reset_credits?: { available_count?: unknown } | null;
	} | null;
	const count = payload?.rate_limit_reset_credits?.available_count;
	const availableResets =
		typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
	const rate = payload?.rate_limit ?? (availableResets !== undefined ? {} : undefined);
	if (!rate || typeof rate !== "object" || Array.isArray(rate))
		throw new Error("Limites indisponíveis: formato desconhecido.");
	const windows: UsageWindow[] = [];
	for (const key of ["primary_window", "secondary_window"] as const) {
		const w = (rate as Record<string, unknown>)[key] as Record<string, unknown> | null;
		if (w == null) continue;
		const { used_percent: used, limit_window_seconds: seconds, reset_at: resetAt } = w;
		if (
			typeof used !== "number" ||
			!Number.isFinite(used) ||
			used < 0 ||
			used > 100 ||
			typeof seconds !== "number" ||
			!Number.isInteger(seconds) ||
			seconds <= 0 ||
			typeof resetAt !== "number" ||
			!Number.isFinite(resetAt) ||
			resetAt <= 0 ||
			resetAt > 8.64e12
		) {
			throw new Error("Limites indisponíveis: janela inválida.");
		}
		windows.push({ used, seconds, resetAt: resetAt * 1000 });
	}
	return { windows, checkedAt: Date.now(), availableResets };
}

/** Internal endpoint used by the official Codex client; not a stable public API. */
export async function fetchUsage(
	access: string,
	accountId: string,
	signal: AbortSignal,
	request: typeof fetch = fetch,
): Promise<Usage> {
	const response = await request("https://chatgpt.com/backend-api/wham/usage", {
		method: "GET",
		headers: {
			Authorization: `Bearer ${access}`,
			"ChatGPT-Account-Id": accountId,
			"User-Agent": "codex-cli",
		},
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			response.status === 401
				? "Login expirado; remova e autentique novamente."
				: `Limites indisponíveis (HTTP ${response.status}).`,
		);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Limites indisponíveis: resposta vazia.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 128 * 1024) throw new Error("Resposta de limites grande demais.");
			chunks.push(value);
		}
		return parseUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

export function usageSummary(usage: Usage): string {
	const describe = (seconds: number, label: string) => {
		const w = usage.windows.find((item) => item.seconds === seconds);
		return w ? `${label}: ${Math.round(100 - w.used)}% livre` : `${label}: não informado`;
	};
	return `${describe(18000, "5h")} · ${describe(604800, "semana")} · resets: ${usage.availableResets ?? "não informado"}`;
}
