import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { detectSupportedImageMimeTypeFromFile } from "pi-sdk";
import type {
	AttachmentReference,
	Backend,
	LedgerEvent,
	PermissionMode,
	RelaySession,
	RuntimeSelection,
} from "./contracts.ts";
import { RelayClient } from "./service/client.ts";
import { applicationDirectory } from "./service/paths.ts";
import { type RelayCommand, selection, validateSelection } from "./service/protocol.ts";
import { imageMediaType } from "./sessions/artifacts.ts";
import { PublicHistoryRenderer, replayEvents } from "./sessions/public-history.ts";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}
function runtime(): RuntimeSelection {
	const backend = option("--backend") || "codex";
	if (!["codex", "claude", "pi"].includes(backend)) throw new Error("Choose codex, claude, or pi");
	return selection(backend as Backend, option("--model") || "", option("--profile"), option("--provider"));
}

async function main(): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`Relay native-runtime CLI
  relay new --workspace PATH --backend codex|claude|pi --model MODEL [--provider PROVIDER] [--profile PATH]
  relay list
  relay show --session ID
  relay switch --session ID --backend BACKEND --model MODEL [--provider PROVIDER] [--profile PATH]
  relay chat --session ID
  relay prompt --session ID --text TEXT [--attach PATH] [--permission ask|auto-edit|read-only] [--json]
  relay cancel --session ID
  relay reset --session ID --description "native session unavailable; retain Relay history"
  relay reconcile --session ID --turn ID --description "verified native execution and effects"
  relay export --session ID --output PATH
  relay rpc (version 1 JSONL commands; approval responses are separate commands)
  --config PATH loads a runtime selection JSON with explicit backend options/MCP configuration.
  Sessions are shared with desktop. Data: ${applicationDirectory()}
`);
		return;
	}
	const client = await RelayClient.connect();
	const sessionId = option("--session");
	const command = args[0] || "chat";
	const configured = async () =>
		option("--config") ? validateSelection(JSON.parse(await readFile(option("--config")!, "utf8"))) : runtime();
	try {
		if (command === "new") {
			const session = (await client.request({
				type: "create",
				sessionId: randomUUID(),
				workspace: option("--workspace") || process.cwd(),
				selection: await configured(),
			})) as RelaySession;
			process.stdout.write(`${session.id}\n`);
			return;
		}
		if (command === "list") {
			process.stdout.write(`${JSON.stringify(await client.request({ type: "list" }), null, 2)}\n`);
			return;
		}
		if (command === "rpc") {
			const lines = createInterface({ input: process.stdin });
			client.subscribe((event) => process.stdout.write(`${JSON.stringify({ version: 1, event })}\n`));
			const pending = new Set<Promise<void>>();
			for await (const line of lines) {
				try {
					const request = JSON.parse(line) as { id: string; command: RelayCommand };
					const operation = client.request(request.command).then(
						(result) => {
							process.stdout.write(`${JSON.stringify({ version: 1, id: request.id, result })}\n`);
						},
						(error: unknown) => {
							process.stdout.write(`${JSON.stringify({ version: 1, id: request.id, error: String(error) })}\n`);
						},
					);
					pending.add(operation);
					void operation.finally(() => pending.delete(operation));
				} catch (error) {
					process.stdout.write(`${JSON.stringify({ version: 1, error: String(error) })}\n`);
				}
			}
			await Promise.all(pending);
			return;
		}
		if (!sessionId) throw new Error("Use --session ID (create one with relay new)");
		if (command === "show") {
			process.stdout.write(`${JSON.stringify(await client.request({ type: "get", sessionId }), null, 2)}\n`);
			return;
		}
		if (command === "switch") {
			await client.request({ type: "select", sessionId, selection: await configured() });
			return;
		}
		if (command === "cancel") {
			process.stdout.write(`${await client.request({ type: "cancel", sessionId })}\n`);
			return;
		}
		if (command === "reconcile") {
			await client.request({
				type: "reconcile",
				sessionId,
				turnId: option("--turn") || "",
				description: option("--description") || "",
			});
			return;
		}
		if (command === "reset") {
			await client.request({ type: "reset", sessionId, description: option("--description") || "" });
			return;
		}
		if (command === "export") {
			await writeFile(
				option("--output") || `relay-${sessionId}.json`,
				JSON.stringify(await client.request({ type: "get", sessionId }), null, 2),
				{ mode: 0o600 },
			);
			return;
		}
		if (command !== "chat" && command !== "prompt") throw new Error("Unknown Relay command; use --help");
		const mode = option("--permission") || "ask";
		if (!["ask", "auto-edit", "read-only"].includes(mode)) throw new Error("Invalid permission mode");
		const json = args.includes("--json");
		const attachmentIds: string[] = [];
		for (let index = 0; index < args.length; index++) {
			if (args[index] !== "--attach") continue;
			if (!args[index + 1]) throw new Error("--attach requires a file path");
			const path = args[++index];
			const mimeType = await detectSupportedImageMimeTypeFromFile(path);
			let mediaType: AttachmentReference["mediaType"] = "text/plain";
			if (mimeType) {
				if (!imageMediaType(mimeType)) throw new Error("Unsupported image attachment");
				mediaType = mimeType;
			}
			const attachment = (await client.request({
				type: "attach",
				sessionId,
				mediaType,
				data: (await readFile(path)).toString("base64"),
				description: path,
			})) as AttachmentReference;
			attachmentIds.push(attachment.id);
		}
		const lines = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: process.stdin.isTTY && !json,
		});
		// Buffer piped input while the saved-history snapshot is loading.
		const input = lines[Symbol.asyncIterator]();
		let busy = false;
		const renderer = new PublicHistoryRenderer();
		const approvals = renderer.approvals;
		const render = (event: LedgerEvent) => {
			if (event.sessionId !== sessionId) return;
			process.stdout.write(json ? `${JSON.stringify(event)}\n` : renderer.render(event));
		};
		let replayed = command !== "chat";
		let cursor = 0;
		const queued: LedgerEvent[] = [];
		const unsubscribe = client.subscribe((event) => {
			if (event.sessionId !== sessionId) return;
			if (!replayed) queued.push(event);
			else if (event.sequence > cursor) {
				cursor = event.sequence;
				render(event);
			}
		});
		try {
			if (command === "chat") {
				const snapshot = (await client.request({ type: "get", sessionId })) as RelaySession;
				for (const entry of replayEvents(snapshot, json)) render(entry);
				cursor = snapshot.events.at(-1)?.sequence ?? 0;
				replayed = true;
				for (const event of queued)
					if (event.sequence > cursor) {
						cursor = event.sequence;
						render(event);
					}
			}
			let running: Promise<void> = Promise.resolve();
			const submit = (value: string) => {
				if (busy) {
					process.stdout.write("Execution active; use /cancel or wait.\n");
					return;
				}
				busy = true;
				running = client
					.request({
						type: "submit",
						sessionId,
						turnId: randomUUID(),
						text: value,
						permissionMode: mode as PermissionMode,
						attachmentIds: attachmentIds.splice(0),
					})
					.then(
						(status) => {
							if (status === "failed" || status === "unknown") process.exitCode = 1;
						},
						(error: unknown) => {
							process.stderr.write(`${String(error)}\n`);
							process.exitCode = 1;
						},
					)
					.finally(() => {
						busy = false;
						if (command === "prompt") lines.close();
					});
			};
			const cancel = () => {
				void client
					.request({ type: "cancel", sessionId })
					.catch((error: unknown) => process.stderr.write(`${String(error)}\n`));
			};
			lines.on("SIGINT", cancel);
			if (command === "prompt") submit(option("--text") || "");
			else if (!json)
				process.stdout.write("/cancel, /allow ID, /deny ID, /switch BACKEND MODEL [PROVIDER], /quit\n");
			for await (const line of input) {
				const value = line.trim();
				if (value === "/quit") {
					if (busy) cancel();
					break;
				}
				if (value === "/cancel") {
					cancel();
					continue;
				}
				if (value.startsWith("/allow ") || value.startsWith("/deny ")) {
					const id = value.split(" ")[1];
					if (!approvals.has(id) && !json) {
						process.stderr.write("Approval no longer pending\n");
						continue;
					}
					await client.request({
						type: "approval",
						sessionId,
						approvalId: id,
						allowed: value.startsWith("/allow "),
					});
					continue;
				}
				if (value.startsWith("/switch ")) {
					const [, backend, model, provider] = value.split(/\s+/);
					await client.request({
						type: "select",
						sessionId,
						selection: validateSelection(
							selection(backend as Backend, model || "", option("--profile"), provider),
						),
					});
					continue;
				}
				if (value) submit(value);
			}
			await running;
		} finally {
			unsubscribe();
			lines.close();
		}
	} finally {
		client.close();
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
