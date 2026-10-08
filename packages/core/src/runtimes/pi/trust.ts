import { dirname } from "node:path";
import {
	type DefaultProjectTrust,
	hasTrustRequiringProjectResources,
	type LoadExtensionsResult,
	type ProjectTrustContext,
	ProjectTrustStore,
} from "pi-sdk";

/** Small host policy using public loaded handlers and trust storage; no private pi helper imports. */
export async function resolveTrust(input: {
	cwd: string;
	profile: string;
	override?: boolean;
	defaultTrust: DefaultProjectTrust;
	extensions: LoadExtensionsResult;
	context: ProjectTrustContext;
}): Promise<boolean> {
	if (input.override !== undefined) return input.override;
	if (!hasTrustRequiringProjectResources(input.cwd)) return true;
	const store = new ProjectTrustStore(input.profile);
	for (const extension of input.extensions.extensions) {
		for (const handler of [...(extension.handlers.get("project_trust") ?? [])]) {
			try {
				const response = await handler({ type: "project_trust", cwd: input.cwd }, input.context);
				if (
					!response ||
					typeof response !== "object" ||
					!("trusted" in response) ||
					!["yes", "no"].includes(String(response.trusted))
				)
					continue;
				const trusted = response.trusted === "yes";
				if ("remember" in response && response.remember === true) store.set(input.cwd, trusted);
				return trusted;
			} catch (error) {
				input.context.ui.notify(`Extension ${extension.path} project_trust failed: ${String(error)}`, "error");
			}
		}
	}
	const remembered = store.get(input.cwd);
	if (remembered !== null) return remembered;
	if (input.defaultTrust !== "ask") return input.defaultTrust === "always";
	if (!input.context.hasUI) return false;
	const parent = dirname(input.cwd);
	const choices = [
		"Trust this session",
		"Trust this folder",
		...(parent === input.cwd ? [] : [`Trust parent folder (${parent})`]),
		"Do not trust",
		"Do not trust this session",
	];
	const choice = await input.context.ui.select(
		`Load project configuration, packages, extensions, and skills in ${input.cwd}?`,
		choices,
	);
	if (choice === "Trust this folder") store.set(input.cwd, true);
	else if (choice === `Trust parent folder (${parent})`)
		store.setMany([
			{ path: parent, decision: true },
			{ path: input.cwd, decision: null },
		]);
	else if (choice === "Do not trust") store.set(input.cwd, false);
	return (
		choice === "Trust this session" || choice === "Trust this folder" || choice === `Trust parent folder (${parent})`
	);
}

export function noTrustUI(cwd: string): ProjectTrustContext {
	return {
		cwd,
		mode: "rpc",
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message) => {
				process.stderr.write(`${message}\n`);
			},
		},
	};
}
