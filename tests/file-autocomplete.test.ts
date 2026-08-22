import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isFilesystemQuery,
	resolveFilesystemQuery,
	searchFilesystem,
} from "../extensions/file-autocomplete/filesystem.js";
import { buildProjectFileIndex, parseFileList } from "../extensions/file-autocomplete/indexer.js";
import { extractAtFileQuery, rankFiles } from "../extensions/file-autocomplete/search.js";

describe("project file autocomplete", () => {
	it("extracts unquoted and quoted @ queries at token boundaries", () => {
		expect(extractAtFileQuery("review @src/ind")).toEqual({
			prefix: "@src/ind",
			query: "src/ind",
			quoted: false,
		});
		expect(extractAtFileQuery('open @"docs/user gu')).toEqual({
			prefix: '@"docs/user gu',
			query: "docs/user gu",
			quoted: true,
		});
		expect(extractAtFileQuery("email@example.com")).toBeUndefined();
	});

	it("recognizes home and absolute filesystem queries", () => {
		expect(isFilesystemQuery("~/Downloads/image")).toBe(true);
		expect(isFilesystemQuery("/home/user/image")).toBe(true);
		expect(isFilesystemQuery("src/image")).toBe(false);
		expect(resolveFilesystemQuery("", homedir())).toBe("~/");
		expect(resolveFilesystemQuery("Down", homedir())).toBe("~/Down");
		expect(resolveFilesystemQuery("src/image", "/tmp/project")).toBeUndefined();
	});

	it("lists direct absolute-path matches without recursively scanning the root", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-core-autocomplete-"));
		const filePath = join(directory, "sidebar-image.png");
		await writeFile(filePath, "image");
		expect(await searchFilesystem(join(directory, "sidebar"))).toContain(filePath);
	});

	it("indexes the repository through Git while excluding ignored files", async () => {
		const files = await buildProjectFileIndex(process.cwd());
		expect(files).toContain("package.json");
		expect(files.some((path) => path.startsWith("node_modules/"))).toBe(false);
	});

	it("filters ignored heavy directories from command output", () => {
		expect(
			parseFileList(
				[
					"src/index.ts",
					"node_modules/pkg/index.js",
					"dist/app.js",
					".next/cache/file",
					"README.md",
					"",
				].join("\0"),
			),
		).toEqual(["src/index.ts", "README.md"]);
	});

	it("ranks exact and fuzzy filename matches ahead of path-only matches", () => {
		const query = extractAtFileQuery("@fauto");
		if (!query) throw new Error("Expected @ query");
		const items = rankFiles(
			["docs/file-autocomplete-notes.md", "extensions/file-autocomplete/index.ts", "src/feature/auto.ts"],
			query,
		);
		expect(items[0]?.description).toBe("docs/file-autocomplete-notes.md");
		expect(items.map((item) => item.description)).toContain("extensions/file-autocomplete/index.ts");
	});

	it("keeps only the highest-ranked bounded results", () => {
		const query = extractAtFileQuery("@file");
		if (!query) throw new Error("Expected @ query");
		const items = rankFiles(["z/file.ts", "a/file.ts", "file.ts", "other.ts"], query, 2);
		expect(items.map((item) => item.description)).toEqual(["a/file.ts", "file.ts"]);
	});

	it("quotes completion values for paths containing spaces", () => {
		const query = extractAtFileQuery("attach @guide");
		if (!query) throw new Error("Expected @ query");
		expect(rankFiles(["docs/guide image.png"], query)[0]).toMatchObject({
			value: '@"docs/guide image.png"',
			label: "guide image.png",
		});
	});
});
