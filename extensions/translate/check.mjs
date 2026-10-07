import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { LocalTranslator } = await jiti.import("./backend.ts");
const { translateText } = await jiti.import("./text.ts");
const translator = new LocalTranslator();
const prompts = [
	"pode implementar isso. dai eu faço reload nesta sessao para testar",
	"Não remova os testes e não instale dependências novas. Corrija apenas o erro de validação.",
	"Corrija `validateInput` em /home/dev/projeto/src/index.ts sem alterar a API pública.\n```ts\nconst mensagem = 'não traduzir';\n```",
	"Gostaria que você pesquisasse as opções antes de mudar qualquer arquivo. Isto ainda não é uma autorização para implementar.",
	"isso nao deveria injetar absolutamente nada de contexto para o agent, só o prompt traduzido. default desativado e só nesta sessao.",
	"Não aumente o limite de 5 para 10. Preserve o timeout de 1200 ms.",
];
try {
	const startup = performance.now();
	await translator.start();
	console.log(`startup_ms=${Math.round(performance.now() - startup)}`);
	for (const prompt of prompts) {
		const start = performance.now();
		const result = await translateText(prompt, (text) => translator.translate(text));
		console.log(
			JSON.stringify({ ms: Math.round(performance.now() - start), original: prompt, translated: result }),
		);
	}
} finally {
	await translator.stop();
}
