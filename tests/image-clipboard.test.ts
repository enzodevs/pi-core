import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClipboardImageDraft } from "../extensions/image-clipboard/state.js";

const drafts: ClipboardImageDraft[] = [];

function createDraft(): ClipboardImageDraft {
	const draft = new ClipboardImageDraft();
	drafts.push(draft);
	return draft;
}

async function clipboardFile(name: string, contents: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-core-image-test-"));
	const filePath = join(directory, name);
	await writeFile(filePath, contents);
	return filePath;
}

afterEach(async () => {
	await Promise.all(drafts.splice(0).map((draft) => draft.reset()));
});

describe("clipboard image drafts", () => {
	it("replaces image paths with numbered placeholders", async () => {
		const first = await clipboardFile("first.png", "first");
		const second = await clipboardFile("second.jpg", "second");
		const draft = createDraft();
		expect(draft.capture(first)).toBe("[Image 01]");
		expect(draft.capture(second)).toBe("[Image 02]");
		expect(draft.capture("/tmp/ordinary.png")).toBeUndefined();
	});

	it("captures pasted image paths without deleting the original file", async () => {
		const filePath = await clipboardFile("sidebar-image.png", "image");
		const draft = createDraft();

		expect(draft.capture(filePath)).toBe("[Image 01]");
		await draft.reset();

		expect(await readFile(filePath, "utf8")).toBe("image");
	});

	it("does not treat a clipboard-shaped filename outside the OS temp root as owned", async () => {
		const filePath = await clipboardFile(
			"pi-clipboard-123e4567-e89b-42d3-a456-426614174003.png",
			"user image",
		);
		const draft = createDraft();
		expect(draft.capture(filePath)).toBe("[Image 01]");

		await draft.reset();

		expect(await readFile(filePath, "utf8")).toBe("user image");
	});

	it("ignores pasted paths that are not supported image files", async () => {
		const filePath = await clipboardFile("notes.txt", "text");
		const draft = createDraft();
		expect(draft.capture(filePath)).toBeUndefined();
	});

	it("attaches only placeholders still present in the submitted draft", async () => {
		const first = await clipboardFile("pi-clipboard-aaaa-1111.png", "first");
		const second = await clipboardFile("pi-clipboard-bbbb-2222.webp", "second");
		const draft = createDraft();
		draft.capture(first);
		draft.capture(second);

		expect(await draft.attachmentsFor("Compare [Image 02]")).toEqual([
			{
				type: "image",
				mimeType: "image/webp",
				data: Buffer.from("second").toString("base64"),
			},
		]);
	});

	it("reconciles images removed through ordinary editor changes", async () => {
		const filePath = await clipboardFile("reconcile.png", "image");
		const draft = createDraft();
		draft.capture(filePath);

		draft.reconcile("marker was edited");

		expect(draft.previews()).toEqual([]);
		expect(await draft.attachmentsFor("[Image 01]")).toEqual([]);
	});

	it("detaches a removed placeholder from the draft", async () => {
		const filePath = await clipboardFile("pi-clipboard-eeee-5555.png", "image");
		const draft = createDraft();
		const placeholder = draft.capture(filePath);
		expect(placeholder).toBe("[Image 01]");
		if (!placeholder) throw new Error("Expected clipboard image placeholder");

		draft.detach(placeholder);

		expect(await draft.attachmentsFor(placeholder)).toEqual([]);
	});

	it("never deletes matching files in the OS temp root and resets numbering", async () => {
		const filePath = join(tmpdir(), "pi-clipboard-123e4567-e89b-42d3-a456-426614174004.gif");
		await writeFile(filePath, "image");
		const draft = createDraft();
		expect(draft.capture(filePath)).toBe("[Image 01]");

		draft.reset();

		expect(await readFile(filePath, "utf8")).toBe("image");
		expect(draft.capture(filePath)).toBe("[Image 01]");
		await unlink(filePath);
	});
});
