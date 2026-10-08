import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ImageContent } from "pi-ai";
import {
	type AgentSessionRuntime,
	type Args,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	detectSupportedImageMimeTypeFromFile,
	getAgentDir,
	InteractiveMode,
	ModelRuntime,
	parseArgs,
	main as piMain,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	runPrintMode,
	runRpcMode,
	SessionManager,
	SettingsManager,
	VERSION,
} from "pi-sdk";
import type { PermissionMode, RelaySession } from "../contracts.ts";
import { noTrustUI, resolveTrust } from "../runtimes/pi/trust.ts";
import { RelayClient } from "../service/client.ts";
import { applicationDirectory } from "../service/paths.ts";
import { terminalHost } from "./host.ts";
import { TerminalSessions } from "./sessions.ts";

async function sessionManager(args: Args, cwd: string, global?: RelaySession): Promise<SessionManager> {
	if (args.noSession) return SessionManager.inMemory(cwd);
	if (args.session || args.fork || args.sessionId) {
		const reference = args.session ?? args.fork ?? args.sessionId!;
		const list = await SessionManager.list(cwd, args.sessionDir);
		const matches = list.filter((session) => session.id.startsWith(reference) || session.path === resolve(reference));
		if (matches.length > 1) throw new Error("Ambiguous native session ID");
		const path = matches[0]?.path ?? (reference.endsWith(".jsonl") ? resolve(reference) : undefined);
		if (!path && args.sessionId) return SessionManager.create(cwd, args.sessionDir, { id: args.sessionId });
		if (!path) throw new Error("Native session unavailable");
		await readFile(path);
		return args.fork
			? SessionManager.forkFrom(path, cwd, args.sessionDir)
			: SessionManager.open(path, args.sessionDir);
	}
	if (args.resume) {
		const sessions = await SessionManager.list(cwd, args.sessionDir);
		if (!sessions.length) throw new Error("No native pi sessions in this workspace");
		const lines = createInterface({ input: process.stdin, output: process.stderr });
		try {
			sessions.forEach((session, index) => {
				process.stderr.write(`${index + 1}: ${session.name ?? session.firstMessage} (${session.id})\n`);
			});
			const selected = Number(await lines.question("Session number: ")) - 1;
			if (!Number.isInteger(selected) || !sessions[selected]) throw new Error("Invalid session choice");
			return SessionManager.open(sessions[selected].path, args.sessionDir);
		} finally {
			lines.close();
		}
	}
	if (args.continue) return SessionManager.continueRecent(cwd, args.sessionDir);
	if (global) {
		const record = [...global.natives]
			.reverse()
			.find(
				(record) =>
					record.role === "foreground" &&
					record.branch === global.branch &&
					record.status === "available" &&
					record.selection.backend === "pi" &&
					record.workspace === cwd,
			);
		if (record?.nativeFile) {
			await readFile(record.nativeFile);
			return SessionManager.open(record.nativeFile, undefined, cwd);
		}
		if (record?.nativeId) {
			const directory = join(applicationDirectory(), "native", record.id);
			const file = (await readdir(directory)).find((file) => file.endsWith(`_${record.nativeId}.jsonl`));
			if (!file) throw new Error("Native session missing; use relay reset after verifying execution");
			return SessionManager.open(join(directory, file), directory, cwd);
		}
	}
	return SessionManager.create(cwd, args.sessionDir);
}

export async function runTerminal(argv: string[]): Promise<void> {
	process.env.PI_TELEMETRY = "0";
	if (argv.includes("--offline")) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}
	if (["auth", "config", "install", "remove", "uninstall", "update", "list"].includes(argv[0])) {
		await piMain(argv);
		return;
	}
	if (argv[0] === "mcp")
		throw new Error(
			"Relay MCP integration is configured explicitly for native workers; the pi MCP command is disabled.",
		);
	const options = new Map<string, string>();
	const args = parseArgs(
		argv.filter((value, index) => {
			if (["--relay-session", "--profile", "--permission"].includes(value)) {
				if (!argv[index + 1]) throw new Error(`${value} requires a value`);
				options.set(value, argv[index + 1]);
				return false;
			}
			return !["--relay-session", "--profile", "--permission"].includes(argv[index - 1]);
		}),
	);
	if (args.help) {
		process.stdout.write(
			"Relay published pi terminal: --relay-session ID, --profile PATH, --permission ask|auto-edit|read-only\nNative pi flags follow. Use npm run relay for Codex/Claude/global-session commands.\n",
		);
		await piMain(["--help"]);
		return;
	}
	if (args.version) {
		process.stdout.write(`Relay 0.0.3; pi ${VERSION}\n`);
		return;
	}
	if (args.diagnostics.some((diagnostic) => diagnostic.type === "error"))
		throw new Error(args.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	for (const diagnostic of args.diagnostics) process.stderr.write(`${diagnostic.message}\n`);
	if (args.export) {
		await piMain(["--export", args.export, ...args.messages]);
		return;
	}
	const mode = options.get("--permission") ?? "ask";
	if (!["ask", "auto-edit", "read-only"].includes(mode)) throw new Error("Invalid permission mode");
	const profile = options.get("--profile") ?? getAgentDir();
	const id = options.get("--relay-session") ?? randomUUID();
	const client = await RelayClient.connect();
	let runtime: AgentSessionRuntime | undefined;
	const sessions = new TerminalSessions(client, id, options.has("--relay-session"));
	try {
		if (args.noSession && options.has("--relay-session"))
			throw new Error("--no-session starts an ephemeral conversation; omit --relay-session");
		const global = options.has("--relay-session")
			? ((await client.request({ type: "get", sessionId: id })) as RelaySession)
			: undefined;
		if (
			global &&
			global.selection.backend !== "pi" &&
			(args.print || args.mode === "json" || args.mode === "rpc" || !process.stdin.isTTY)
		)
			throw new Error(
				"Pi print/JSON/RPC requires a pi selection. Use relay prompt/rpc for the selected native backend, or explicitly switch this session to pi.",
			);
		const cwd = await realpath(global?.workspace ?? process.cwd());
		const manager = await sessionManager(args, cwd, global);
		if (args.name) manager.appendSessionInfo(args.name);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
			projectTrustContext,
		}) => {
			const target = await sessions.resolve(sessionManager, sessionStartEvent?.reason);
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const trustContext = projectTrustContext ?? noTrustUI(cwd);
			if (!projectTrustContext && process.stdin.isTTY && args.mode !== "rpc" && !args.print) {
				trustContext.hasUI = true;
				trustContext.mode = "tui";
				trustContext.ui.select = async (title, choices) => {
					const lines = createInterface({ input: process.stdin, output: process.stderr });
					try {
						process.stderr.write(
							`${title}\n${choices.map((choice, index) => `${index + 1}: ${choice}`).join("\n")}\n`,
						);
						const choice = Number(await lines.question("Choice (blank denies): ")) - 1;
						return choices[choice];
					} finally {
						lines.close();
					}
				};
			}
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime: await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					allowModelNetwork: false,
					refreshOnCreate: !args.offline,
				}),
				extensionFlagValues: args.unknownFlags,
				resourceLoaderOptions: {
					disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
					extensionFactories: [
						{
							name: "relay-host",
							factory: terminalHost(client, target.id, agentDir, mode as PermissionMode, (manager) =>
								sessions.navigate(manager),
							),
						},
					],
					extensionsOverride: (base) => ({
						...base,
						extensions: [
							...base.extensions.filter((extension) => extension.path !== "<inline:relay-host>"),
							...base.extensions.filter((extension) => extension.path === "<inline:relay-host>"),
						],
					}),
					additionalExtensionPaths: args.extensions?.map((path) =>
						path.startsWith("builtin:") ? path : resolve(path),
					),
					additionalSkillPaths: args.skills?.map((path) => resolve(path)),
					additionalPromptTemplatePaths: args.promptTemplates?.map((path) => resolve(path)),
					additionalThemePaths: args.themes?.map((path) => resolve(path)),
					noExtensions: args.noExtensions,
					noSkills: args.noSkills,
					noPromptTemplates: args.noPromptTemplates,
					noThemes: args.noThemes,
					noContextFiles: args.noContextFiles,
					systemPrompt: args.systemPrompt,
					appendSystemPrompt: args.appendSystemPrompt,
				},
				resourceLoaderReloadOptions: {
					resolveProjectTrust: ({ extensionsResult }) =>
						resolveTrust({
							cwd,
							profile: agentDir,
							override: args.projectTrustOverride,
							defaultTrust: settingsManager.getDefaultProjectTrust(),
							extensions: extensionsResult,
							context: trustContext,
						}),
				},
			});
			for (const diagnostic of services.diagnostics) process.stderr.write(`${diagnostic.message}\n`);
			if (services.diagnostics.some((diagnostic) => diagnostic.type === "error"))
				throw new Error("Pi startup diagnostics contain errors");
			const selected =
				(!sessionStartEvent || sessionStartEvent.reason === "startup") && global?.selection.backend === "pi"
					? global.selection
					: undefined;
			const resolved = resolveCliModel({
				cliProvider: args.provider ?? selected?.options.provider,
				cliModel: args.model ?? selected?.model,
				cliThinking: args.thinking,
				modelRuntime: services.modelRuntime,
			});
			if (resolved.error) throw new Error(resolved.error);
			if (args.apiKey) {
				const provider = args.provider ?? resolved.model?.provider;
				if (!provider) throw new Error("--api-key requires a resolvable provider/model");
				await services.modelRuntime.setRuntimeApiKey(provider, args.apiKey);
			}
			const scope = args.models
				? await resolveModelScopeWithDiagnostics(args.models, services.modelRuntime)
				: undefined;
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model:
					resolved.model ??
					(global && global.selection.backend !== "pi" ? services.modelRuntime.getModels()[0] : undefined),
				thinkingLevel: args.thinking ?? resolved.thinkingLevel,
				scopedModels: scope?.scopedModels,
				noTools: args.noTools ? "all" : args.noBuiltinTools ? "builtin" : undefined,
				tools: mode === "read-only" ? ["read", "grep", "find", "ls", "relay_delegate_task"] : args.tools,
				excludeTools: args.excludeTools,
			});
			if (result.session.model && !args.listModels)
				await sessions.register(
					sessionManager,
					target,
					{
						backend: "pi",
						profile: agentDir,
						model: result.session.model.id,
						options: { provider: result.session.model.provider, thinking: result.session.thinkingLevel },
					},
					args.noSession === true,
				);
			return { ...result, services, diagnostics: [...services.diagnostics, ...(scope?.diagnostics ?? [])] };
		};
		runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: profile, sessionManager: manager });
		if (args.listModels) {
			const query = typeof args.listModels === "string" ? args.listModels.toLowerCase() : "";
			for (const model of runtime.services.modelRuntime.getModels())
				if (`${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
					process.stdout.write(`${model.provider}/${model.id}\t${model.name}\n`);
			return;
		}
		if (!runtime.session.model)
			throw new Error("No authenticated pi model; configure a profile or select --provider and --model");
		const images: ImageContent[] = [];
		const contents: string[] = [];
		for (const path of args.fileArgs) {
			const mimeType = await detectSupportedImageMimeTypeFromFile(path);
			if (mimeType) images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType });
			else contents.push(`File ${JSON.stringify(path)}:\n${await readFile(path, "utf8")}`);
		}
		if (!process.stdin.isTTY && args.mode !== "rpc") {
			for await (const chunk of process.stdin) contents.push(String(chunk));
		}
		const initialMessage = [...contents, ...(args.messages[0] ? [args.messages[0]] : [])].join("\n");
		if (args.mode === "rpc") await runRpcMode(runtime);
		else if (args.print || args.mode === "json" || !process.stdin.isTTY)
			process.exitCode = await runPrintMode(runtime, {
				mode: args.mode === "json" ? "json" : "text",
				initialMessage,
				initialImages: images,
				messages: args.messages.slice(1),
			});
		else {
			process.stderr.write(`Relay session: ${sessions.sessionId}\n`);
			await new InteractiveMode(runtime, {
				initialMessage,
				initialImages: images,
				initialMessages: args.messages.slice(1),
				verbose: args.verbose,
				tuiMode: args.tuiMode,
				initialThemeSetting: args.useTheme,
			}).run();
		}
	} finally {
		try {
			await runtime?.dispose();
			// Quarantined execution metadata is retained until explicit reconciliation.
			for (const sessionId of sessions.ephemeralIds)
				await client.request({ type: "forget_ephemeral", sessionId }).catch(() => {});
		} finally {
			client.close();
		}
	}
}

void runTerminal(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
