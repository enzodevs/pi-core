interface CatalogProfile {
	name: string;
	description: string;
}

interface CatalogModel {
	provider: string;
	id: string;
	name: string;
}

/** Compact discovery only: never resolve fuzzy names into launch arguments. */
export function buildAgentCatalog(
	profiles: readonly CatalogProfile[],
	models: readonly CatalogModel[],
	query = "",
) {
	const terms = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	const matches = models.filter((model) => {
		const text = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
		return terms.every((term) => text.includes(term));
	});
	// Never truncate identifiers: callers must be able to copy them exactly.
	const agents = profiles
		.filter((profile) => profile.name.length <= 256)
		.slice(0, 12)
		.map((profile) => ({ name: profile.name, description: profile.description.slice(0, 160) }));
	const availableModels = matches
		.filter((model) => `${model.provider}/${model.id}`.length <= 256)
		.slice(0, 12)
		.map((model) => ({ model: `${model.provider}/${model.id}`, name: model.name.slice(0, 160) }));
	return {
		agents,
		agentsOmitted: profiles.length - agents.length,
		models: availableModels,
		modelsMatched: matches.length,
		modelsOmitted: matches.length - availableModels.length,
	};
}
