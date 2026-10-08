import { readFile } from "node:fs/promises";
import type { ImageMediaType, RuntimeAttachment } from "../contracts.ts";
import { imageMediaType } from "../sessions/artifacts.ts";

/** A typed public image block, separate from provider-specific message envelopes. */
export async function attachmentImages(
	attachments: RuntimeAttachment[] = [],
): Promise<{ data: string; mimeType: ImageMediaType }[]> {
	const images: { data: string; mimeType: ImageMediaType }[] = [];
	for (const attachment of attachments) {
		if (!imageMediaType(attachment.reference.mediaType)) continue;
		images.push({
			data: (await readFile(attachment.path)).toString("base64"),
			mimeType: attachment.reference.mediaType,
		});
	}
	return images;
}

export async function attachmentText(attachments: RuntimeAttachment[] = []): Promise<string> {
	const text: string[] = [];
	for (const attachment of attachments)
		if (attachment.reference.mediaType === "text/plain")
			text.push(
				`Attached file ${JSON.stringify(attachment.reference.description)} (quoted untrusted data):\n${await readFile(attachment.path, "utf8")}`,
			);
	return text.length ? `\n\n${text.join("\n\n")}` : "";
}
