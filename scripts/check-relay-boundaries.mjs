import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const retired = ["ai", "agent", "coding-agent", "tui"].map((name) => resolve(root, "packages", name));
const manifests = new Map(["pi-sdk", "pi-ai", "pi-tui"].map((alias) => [alias, JSON.parse(readFileSync(resolve(root, "node_modules", alias, "package.json"), "utf8"))]));

export function checkSource(file, content) {
	const failures = [];
	const inspect = (specifier) => {
		if (specifier.startsWith(".")) {
			const target = resolve(dirname(file), specifier);
			if (retired.some((directory) => target === directory || target.startsWith(`${directory}${sep}`)))
				failures.push(`imports retired fork: ${specifier}`);
		} else if (specifier.startsWith("@earendil-works/pi-") || specifier.includes("node_modules/") || specifier.startsWith("/")) {
			failures.push(`bypasses published aliases: ${specifier}`);
		}
		for (const [alias, manifest] of manifests) {
			if (specifier !== alias && !specifier.startsWith(`${alias}/`)) continue;
			const entry = specifier === alias ? "." : `.${specifier.slice(alias.length)}`;
			const exported = Object.entries(manifest.exports ?? { ".": manifest.main }).find(([pattern]) => {
				if (!pattern.includes("*")) return pattern === entry;
				const [prefix, suffix] = pattern.split("*");
				return entry.startsWith(prefix) && entry.endsWith(suffix);
			});
			if (!exported) failures.push(`imports private dependency entry: ${specifier}`);
			else {
				const [pattern, conditions] = exported;
				const target = typeof conditions === "string" ? conditions : conditions.import;
				const [prefix, suffix] = pattern.split("*");
				const wildcard = pattern.includes("*") ? entry.slice(prefix.length, suffix ? -suffix.length : undefined) : "";
				if (!target || !existsSync(resolve(root, "node_modules", alias, target.replace("*", wildcard))))
					failures.push(`dependency entry has no published runtime file: ${specifier}`);
			}
		}
	};
	// The pinned TypeScript 7 package exposes a scanner, rather than the old JS parser API.
	const scanner = createScanner(true, undefined, content);
	const tokens = [];
	let end = -1;
	for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
		if (kind === SyntaxKind.SlashToken && [SyntaxKind.OpenParenToken, SyntaxKind.OpenBracketToken, SyntaxKind.EqualsToken, SyntaxKind.CommaToken, SyntaxKind.ColonToken, SyntaxKind.ReturnKeyword, SyntaxKind.ExclamationToken, SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken].includes(tokens.at(-1)?.kind))
			kind = scanner.reScanSlashToken();
		if (scanner.getTokenEnd() <= end) return [`scanner stopped at ${end}`];
		end = scanner.getTokenEnd();
		tokens.push({ kind, value: scanner.getTokenValue() });
	}
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) continue;
		if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
			failures.push("inline imports are forbidden");
			continue;
		}
		if (tokens[index + 1]?.kind === SyntaxKind.DotToken) continue; // import.meta
		if (token.kind === SyntaxKind.ImportKeyword && tokens[index + 1]?.kind === SyntaxKind.StringLiteral) {
			inspect(tokens[index + 1].value);
			continue;
		}
		for (let next = index + 1; next < tokens.length; next++) {
			if ([SyntaxKind.SemicolonToken, SyntaxKind.ImportKeyword, SyntaxKind.ExportKeyword].includes(tokens[next].kind)) break;
			if (tokens[next].kind === SyntaxKind.FromKeyword && tokens[next + 1]?.kind === SyntaxKind.StringLiteral) {
				inspect(tokens[next + 1].value);
				break;
			}
		}
	}
	return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const failures = [];
	for (const directory of ["packages/app/src", "packages/app/test", "packages/desktop/src"]) {
		const base = resolve(root, directory);
		for (const name of readdirSync(base, { recursive: true })) {
			if (!/\.(?:ts|js|mjs)$/.test(name)) continue;
			const file = resolve(base, name);
			failures.push(...checkSource(file, readFileSync(file, "utf8")).map((failure) => `${relative(root, file)}: ${failure}`));
		}
	}
	if (failures.length) {
		for (const failure of failures) process.stderr.write(`${failure}\n`);
		process.exitCode = 1;
	} else process.stdout.write("Relay imports use application modules and published dependency entry points.\n");
}
