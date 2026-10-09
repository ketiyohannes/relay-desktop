import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SyntaxKind } from "typescript/unstable/ast";
import { isCallExpression, isExportDeclaration, isImportDeclaration, isImportTypeNode, isStringLiteral } from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";
import { prepareUi } from "./prepare-ui.mjs";
import { checkImport } from "./source-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const arguments_ of [
	["node_modules/@biomejs/biome/bin/biome", "check", "--write", "--error-on-warnings", "."],
	["node_modules/typescript/bin/tsc", "--noEmit"],
]) {
	const result = spawnSync(process.execPath, arguments_, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const failures = [];
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
	for (const [name, version] of Object.entries(manifest[section] ?? {})) {
		const pin = version.startsWith("npm:") ? version.slice(version.lastIndexOf("@") + 1) : version;
		if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pin)) failures.push(`${name} must have an exact npm version: ${version}`);
	}
}

// Inspect the application's real TypeScript project, rather than synthesizing workspace configs.
const config = resolve(root, "tsconfig.json");
const api = new API({ cwd: root });
try {
	const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
	if (!project) throw new Error("TypeScript project was not loaded");
	for (const file of project.rootFiles) {
		const source = project.program.getSourceFile(file);
		const runtime = file.startsWith(resolve(root, "src") + "/");
		const fail = (node, message) => {
			const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
			failures.push(`${file}:${line + 1}: ${message}`);
		};
		function visit(node) {
			if (isImportTypeNode(node) || (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword))
				fail(node, "inline imports are forbidden");
			if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
				for (const message of checkImport(file, node.moduleSpecifier.text, runtime)) fail(node, message);
			}
			node.forEachChild(visit);
		}
		visit(source);
	}
} finally {
	api.close();
}
if (failures.length) {
	for (const message of failures) console.error(message);
	process.exit(1);
}
console.log("Application imports, core boundaries, and dependency pins pass.");

await prepareUi();
const renderer = new URL("../src/renderer/", import.meta.url);
const html = await readFile(new URL("index.html", renderer), "utf8");
for (const [, asset] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
	if (!asset.startsWith("http")) await access(new URL(asset, renderer));
}
await build({ entryPoints: [fileURLToPath(new URL("app.js", renderer))], bundle: true, platform: "browser", format: "esm", write: false });
for (const [entry, format] of [["main/index.ts", "esm"], ["preload/index.ts", "cjs"], ["main/worker.ts", "esm"]]) {
	await build({ entryPoints: [resolve(root, "src", entry)], bundle: true, platform: "node", format, packages: "external", write: false });
}
console.log("Renderer assets, Electron entries, and worker resolve.");
