const MARKER = /__PI_KEEP_\d+__/gu;
const MAX_INPUT_BYTES = 32 * 1024;
const CHUNK_CHARS = 1800;

// Literal technical material is never entrusted to the translation model.
const LITERALS =
	/(^ {0,3}(`{3,}|~{3,})(?![`~])[^\n]*\n[\s\S]*?(?:^ {0,3}\2[ \t]*$|(?![\s\S])))|(?<!`)(`+)(?!`)(?:(?!\3)[\s\S])*?\3(?!`)|https?:\/\/[^\s<>"'`]+|(?:~?\/|\.\.?\/)[^\s<>"'`]+|[\w@.-]+(?:\/[\w@.+-]+)+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|yaml|yml|toml|css|html|gguf)\b|\b\w+_\w+\b|\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b|--[a-zA-Z][\w-]*|-?\b\d+(?:[.,]\d+)*\b|\[Image \d+\]|<[^>\n]+>|"[^"\n]*"|'[^'\n]*'/gmu;

export interface TranslationPlan {
	masked: string;
	literals: string[];
}

export function protectText(text: string): TranslationPlan {
	if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
		throw new Error("Prompt exceeds the 32 KiB translation limit. Split it or use /translate off.");
	}
	if (MARKER.test(text)) {
		MARKER.lastIndex = 0;
		throw new Error("Prompt contains a reserved translation marker. Use /translate off.");
	}
	MARKER.lastIndex = 0;
	const literals: string[] = [];
	const masked = text.replace(LITERALS, (literal: string) => {
		const marker = `__PI_KEEP_${literals.length}__`;
		literals.push(literal);
		return marker;
	});
	return { masked, literals };
}

export function restoreText(plan: TranslationPlan, translation: string): string {
	const expected = plan.literals.map((_literal, index) => `__PI_KEEP_${index}__`);
	const actual = translation.match(MARKER) ?? [];
	if (actual.length !== expected.length || actual.some((marker, index) => marker !== expected[index])) {
		throw new Error("Translator changed a protected literal; prompt was not sent.");
	}
	return translation.replace(MARKER, (marker) => {
		const index = Number(marker.slice("__PI_KEEP_".length, -2));
		return plan.literals[index] ?? marker;
	});
}

export function splitText(text: string): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > CHUNK_CHARS) {
		// Split only at whitespace, never inside an opaque literal marker.
		const prefix = rest.slice(0, CHUNK_CHARS);
		const sentence = [...prefix.matchAll(/[.!?]\s+/gu)].at(-1);
		const natural = Math.max(prefix.lastIndexOf("\n"), sentence ? sentence.index + 1 : -1);
		const boundary = natural >= CHUNK_CHARS / 2 ? natural : prefix.lastIndexOf(" ");
		if (boundary < 1) throw new Error("Prompt contains an oversized unbroken text segment.");
		chunks.push(rest.slice(0, boundary));
		rest = rest.slice(boundary);
	}
	if (rest) chunks.push(rest);
	return chunks;
}

export async function translateText(
	text: string,
	translate: (text: string) => Promise<string>,
): Promise<string> {
	const plan = protectText(text);
	const results: string[] = [];
	for (const chunk of splitText(plan.masked)) {
		const body = chunk.trim();
		if (!body || !body.replace(MARKER, "").match(/\p{L}/u)) {
			results.push(chunk);
			continue;
		}
		const translated = (await translate(body)).trim();
		if (!translated) throw new Error("Translator returned empty text; prompt was not sent.");
		results.push(`${chunk.match(/^\s*/u)?.[0] ?? ""}${translated}${chunk.match(/\s*$/u)?.[0] ?? ""}`);
	}
	const result = restoreText(plan, results.join(""));
	if (Buffer.byteLength(result, "utf8") > MAX_INPUT_BYTES) {
		throw new Error("Translated prompt exceeds 32 KiB; prompt was not sent.");
	}
	return result;
}
