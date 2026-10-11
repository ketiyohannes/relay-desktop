import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

export const maxFrame = 16 * 1024 * 1024;
const chunkSize = 256 * 1024;

/** Preserve message order and respect socket backpressure, including large public bodies. */
export class FrameWriter {
	private pending: Promise<void> = Promise.resolve();
	send(socket: Socket, value: unknown): void {
		const json = JSON.stringify(value);
		this.pending = this.pending
			.then(async () => {
				const transfer = randomUUID();
				const chunked = Buffer.byteLength(json) + 1 > maxFrame;
				for (let offset = 0; offset < json.length; offset += chunked ? chunkSize : json.length) {
					if (socket.destroyed) return;
					const frame = chunked
						? JSON.stringify({
								transfer,
								offset,
								text: json.slice(offset, offset + chunkSize),
								end: offset + chunkSize >= json.length,
							})
						: json;
					if (!socket.write(`${frame}\n`)) {
						await new Promise<void>((resolve) => {
							const done = () => {
								socket.off("drain", done);
								socket.off("close", done);
								resolve();
							};
							socket.once("drain", done);
							socket.once("close", done);
						});
					}
				}
			})
			.catch(() => {
				socket.destroy();
			});
	}
}

/** Each wire frame is bounded; complete messages may span multiple ordered frames. */
export class FrameReader {
	private buffer = "";
	private transfer?: { id: string; length: number; chunks: string[] };
	read(chunk: string, receive: (message: unknown) => void): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const frame = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (Buffer.byteLength(frame) > maxFrame) throw new Error("Relay frame limit exceeded");
			const value: unknown = JSON.parse(frame);
			if (value && typeof value === "object" && "transfer" in value) {
				const part = value as { transfer: string; offset: number; text: string; end: boolean };
				if (
					typeof part.transfer !== "string" ||
					typeof part.text !== "string" ||
					typeof part.end !== "boolean" ||
					!Number.isSafeInteger(part.offset) ||
					part.text.length > chunkSize
				)
					throw new Error("Invalid Relay transfer");
				this.transfer ??= { id: part.transfer, length: 0, chunks: [] };
				if (this.transfer.id !== part.transfer || this.transfer.length !== part.offset)
					throw new Error("Relay transfer gap");
				this.transfer.chunks.push(part.text);
				this.transfer.length += part.text.length;
				if (part.end) {
					const message: unknown = JSON.parse(this.transfer.chunks.join(""));
					this.transfer = undefined;
					receive(message);
				}
			} else {
				if (this.transfer) throw new Error("Interrupted Relay transfer");
				receive(value);
			}
			newline = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer) > maxFrame) throw new Error("Relay frame limit exceeded");
	}
}
