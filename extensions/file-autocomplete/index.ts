import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveFilesystemQuery, searchFilesystem } from "./filesystem.js";
import { ProjectFileIndex } from "./indexer.js";
import { extractAtFileQuery, rankFiles } from "./search.js";

export default function fileAutocomplete(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const index = new ProjectFileIndex(ctx.cwd);
		if (!resolveFilesystemQuery("", ctx.cwd)) void index.get();

		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const query = extractAtFileQuery(beforeCursor);
				if (!query) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				const filesystemPath = resolveFilesystemQuery(query.query, ctx.cwd);
				const files = filesystemPath ? await searchFilesystem(filesystemPath) : await index.get();
				if (options.signal.aborted) return null;
				const rankedQuery = filesystemPath
					? { ...query, query: filesystemPath.endsWith("/") ? "" : basename(filesystemPath) }
					: query;
				const items = rankFiles(files, rankedQuery);
				return items.length > 0 ? { prefix: query.prefix, items } : null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
