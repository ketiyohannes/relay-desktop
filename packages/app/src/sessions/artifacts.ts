import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AttachmentReference, ImageMediaType, RuntimeAttachment } from "../contracts.ts";
import { syncDirectory } from "../storage/durable.ts";

export function imageMediaType(value: string): value is ImageMediaType {
	return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value);
}

/** Content-addressed product artifacts. Native adapters receive verified local references. */
export class ArtifactStore {
	readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}
	async capture(
		sessionId: string,
		mediaType: AttachmentReference["mediaType"],
		data: string,
		description: string,
	): Promise<AttachmentReference> {
		if (!imageMediaType(mediaType) && mediaType !== "text/plain")
			throw new Error("Unsupported attachment media type");
		if (data.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
			throw new Error("Attachment must be canonical base64 within 10 MiB");
		const bytes = Buffer.from(data, "base64");
		if (bytes.toString("base64") !== data) throw new Error("Attachment must be canonical base64");
		if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Attachment must contain 1 byte to 10 MiB");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const directory = join(this.directory, sessionId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await syncDirectory(this.directory);
		const path = join(directory, sha256);
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await syncDirectory(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const reference = {
			id: sha256,
			uri: pathToFileURL(path).href,
			sha256,
			description,
			mediaType,
			bytes: bytes.length,
		};
		await this.resolve(sessionId, reference);
		return reference;
	}
	async resolve(sessionId: string, reference: AttachmentReference): Promise<RuntimeAttachment> {
		if (!/^[a-f0-9]{64}$/.test(reference.id) || reference.id !== reference.sha256)
			throw new Error("Invalid attachment identity");
		const path = join(this.directory, sessionId, reference.id);
		if (fileURLToPath(reference.uri) !== path) throw new Error("Attachment belongs to another session");
		const data = await readFile(path);
		if (data.length !== reference.bytes || createHash("sha256").update(data).digest("hex") !== reference.sha256)
			throw new Error("Attachment missing or altered; reattach before continuing");
		return { reference, path };
	}
}
