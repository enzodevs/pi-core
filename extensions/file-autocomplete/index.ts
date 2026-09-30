import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveFilesystemQuery, searchFilesystem } from "./filesystem.js";
import { ProjectFileIndex } from "./indexer.js";
import { extractAtFileQuery, rankFiles } from "./search.js";

export default function fileAutocomplete(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		let indexedCwd = ctx.cwd;
		let index = new ProjectFileIndex(indexedCwd);
		if (!resolveFilesystemQuery("", indexedCwd)) void index.get();

		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				if (options.signal.aborted) return null;
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const query = extractAtFileQuery(beforeCursor);
				if (!query) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				if (ctx.cwd !== indexedCwd) {
					indexedCwd = ctx.cwd;
					index = new ProjectFileIndex(indexedCwd);
				}
				const filesystemPath = resolveFilesystemQuery(query.query, indexedCwd);
				let files: string[];
				try {
					files = filesystemPath ? await searchFilesystem(filesystemPath) : await index.get();
				} catch {
					if (options.signal.aborted) return null;
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
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
