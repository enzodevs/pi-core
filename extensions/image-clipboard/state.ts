import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface ClipboardImageAttachment {
	data: string;
	mimeType: string;
	type: "image";
}

export interface ClipboardImagePreview {
	filePath: string;
	placeholder: string;
}

type PendingImage = ClipboardImagePreview;
const MIME_TYPES: Readonly<Record<string, string>> = {
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
};

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export class ClipboardImageDraft {
	private nextNumber = 1;
	private readonly pending: PendingImage[] = [];

	capture(filePath: string): string | undefined {
		const extension = extname(filePath).slice(1).toLowerCase();
		if (!MIME_TYPES[extension] || !isFile(filePath)) return undefined;

		const placeholder = `[Image ${String(this.nextNumber).padStart(2, "0")}]`;
		this.nextNumber += 1;
		this.pending.push({ filePath, placeholder });
		return placeholder;
	}

	previews(): readonly ClipboardImagePreview[] {
		return this.pending;
	}

	reconcile(text: string): void {
		for (const image of [...this.pending]) {
			if (!text.includes(image.placeholder)) this.detach(image.placeholder);
		}
	}

	detach(placeholder: string): void {
		const index = this.pending.findIndex((image) => image.placeholder === placeholder);
		if (index === -1) return;
		this.pending.splice(index, 1);
	}

	async attachmentsFor(text: string): Promise<ClipboardImageAttachment[]> {
		const selected = this.pending.filter(({ placeholder }) => text.includes(placeholder));
		return Promise.all(
			selected.map(async ({ filePath }) => {
				const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
				return {
					type: "image" as const,
					mimeType: MIME_TYPES[extension] ?? "image/png",
					data: (await readFile(filePath)).toString("base64"),
				};
			}),
		);
	}

	reset(): void {
		this.pending.length = 0;
		this.nextNumber = 1;
	}
}
