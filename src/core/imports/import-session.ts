import { createHash, randomUUID } from "node:crypto";

import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { expandTildePath } from "../accounts/paths.ts";
import type { DesktopResult } from "../desktop/protocol.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "../desktop/types.ts";
import { DesktopSessionImporter } from "./discovery.ts";
import type { ExternalSession } from "./types.ts";

interface ImportsHost {
	state(): DesktopState;
	publicState(): DesktopState;
	emit(): void;
	synchronize(): Promise<void>;
	save(): Promise<void>;
	publish(): Promise<void>;
	hasService: boolean;
	running(): boolean;
	saving(): boolean;
	setSaving(value: boolean): void;
	append(session: DesktopSession, action: Omit<DesktopAction, "id" | "time">): DesktopAction;
}

export class SessionImports {
	readonly importer = new DesktopSessionImporter();
	readonly internalSessions = new Set<string>();
	readonly importedChannels = new Map<string, string>();
	externalSessions: ExternalSession[] = [];
	discovery?: Promise<void>;
	discoveryWarnings: string[] = [];
	private importQueue: Promise<unknown> = Promise.resolve();
	private lastDiscovery = 0;
	private readonly discoveryRoots?: { provider: "codex" | "claude"; path?: string }[];
	private readonly host: ImportsHost;
	constructor(host: ImportsHost, roots?: { provider: "codex" | "claude"; path?: string }[]) {
		this.host = host;
		this.discoveryRoots = roots;
	}
	refreshSessions(force = true): Promise<void> {
		if (this.discovery) return this.discovery;
		if (!force && Date.now() - this.lastDiscovery < 60000) return Promise.resolve();
		this.lastDiscovery = Date.now();
		this.discovery = this.discoverSessions().finally(() => {
			this.discovery = undefined;
			this.host.emit();
		});
		this.host.emit();
		return this.discovery;
	}
	async discoverSessions(): Promise<void> {
		await this.host.synchronize();
		if (this.host.hasService) await this.host.save();
		const roots = this.discoveryRoots ?? [
			{ provider: "codex" as const },
			{ provider: "claude" as const },
			...this.host.state().accounts.flatMap((account) =>
				account.configDir && (account.engine === "claude" || account.credentialSource === "codex")
					? [
							{
								provider: account.engine === "claude" ? ("claude" as const) : ("codex" as const),
								path: account.configDir,
							},
							...(account.equivalentProfiles || []).map((path) => ({
								provider: account.engine === "claude" ? ("claude" as const) : ("codex" as const),
								path,
							})),
						]
					: [],
			),
		];
		const unique = [...new Map(roots.map((root) => [`${root.provider}:${root.path || ""}`, root])).values()];
		const results = await Promise.allSettled(unique.map((root) => this.importer.list(root.provider, root.path)));
		const sources = new Map<string, ExternalSession>();
		const warnings: string[] = [];
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled") {
				warnings.push(...result.value.warnings);
				for (const source of result.value.items) {
					const key = `${source.provider}:${source.sessionId}`;
					if (!sources.has(key) || sources.get(key)!.updated < source.updated) sources.set(key, source);
				}
			} else if ((result.reason as NodeJS.ErrnoException)?.code !== "ENOENT") {
				warnings.push(
					`Could not discover ${unique[index].provider} sessions in ${unique[index].path || "the default profile"}.`,
				);
			}
		}
		this.externalSessions = [...sources.values()].sort((a, b) => b.updated - a.updated);
		this.discoveryWarnings = warnings;
	}
	localSessionId(source: ExternalSession): string {
		return `external-${createHash("sha256").update(`${source.provider}:${source.sessionId}`).digest("hex")}`;
	}
	queuedImport(sourceId: string, project?: string, automatic = false): Promise<DesktopResult> {
		const operation = this.importQueue.then(() => this.importSession(sourceId, project, automatic));
		this.importQueue = operation.catch(() => {});
		return operation;
	}
	async importSession(sourceId: string, overrideProject?: string, automatic = false): Promise<DesktopResult> {
		if ((!automatic && this.host.running()) || this.host.saving())
			throw new Error("Wait for the current run or save before importing");
		this.host.setSaving(true);
		try {
			const { source, actions, warnings } = await this.importer.preview(sourceId);
			const existing = this.host
				.state()
				.sessions.find(
					(session) =>
						session.importedFrom?.provider === source.provider && session.importedFrom.sessionId === source.sessionId,
				);
			if (existing) return { importedSessionId: existing.id };
			let project = overrideProject ? await realpath(expandTildePath(overrideProject)) : source.project;
			if (overrideProject && !(await stat(project)).isDirectory()) throw new Error("Choose a project folder");
			if (!automatic && (!project || !isAbsolute(project))) throw new Error("Choose a project folder for this session");
			if (automatic && !isAbsolute(project)) project = "";
			try {
				project = await realpath(project);
			} catch {
				warnings.push("Original project is unavailable. Use Link folder before sending a prompt.");
			}
			const account =
				this.host
					.state()
					.accounts.find((entry) =>
						source.provider === "claude" ? entry.engine === "claude" : entry.provider === "openai-codex",
					) || this.host.state().accounts[0];
			const session: DesktopSession = {
				id: automatic ? this.localSessionId(source) : randomUUID(),
				project,
				name: source.name.slice(0, 120),
				updated: source.updated,
				accountId: account?.id || "",
				autoSwitch: true,
				actions,
				importedFrom: {
					provider: source.provider,
					sessionId: source.sessionId,
					path: source.path,
					importedAt: Date.now(),
				},
			};
			this.host.append(session, {
				kind: "switch",
				label: "Import details",
				text: `Imported from ${source.provider === "claude" ? "Claude" : "Codex"}. ${warnings.join(" ")}`,
			});
			session.updated = source.updated;
			const addedProject = !this.host.state().projects.includes(project);
			if (addedProject) this.host.state().projects.push(project);
			this.host.state().sessions.push(session);
			try {
				await this.host.publish();
			} catch (error) {
				this.host.state().sessions = this.host.state().sessions.filter((entry) => entry !== session);
				if (addedProject) this.host.state().projects = this.host.state().projects.filter((entry) => entry !== project);
				throw error;
			}
			return { importedSessionId: session.id };
		} finally {
			this.host.setSaving(false);
		}
	}
}
