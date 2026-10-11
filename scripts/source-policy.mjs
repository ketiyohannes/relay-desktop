import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = resolve(root, "src/core") + sep;
const desktop = resolve(core, "desktop") + sep;
const renderer = resolve(root, "src/renderer") + sep;
const features = resolve(renderer, "features") + sep;
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pi = new Map(["pi-sdk", "pi-ai", "pi-tui"].map((name) => [name,
	JSON.parse(readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8")),
]));

/** Keep product code independent of Electron and imports inside public package exports. */
export function checkImport(file, specifier, runtime = false, typeOnly = false) {
	const failures = [];
	if (specifier.startsWith(".")) {
		const target = resolve(dirname(file), specifier);
		if (file.startsWith(core) && !target.startsWith(core)) failures.push(`core imports outside core: ${specifier}`);
		if (file.startsWith(core) && !file.startsWith(desktop) && target.startsWith(desktop) && !typeOnly)
			failures.push(`shared behavior cannot import desktop implementation: ${specifier}`);
		if (file.startsWith(renderer) && !target.startsWith(renderer) && !typeOnly)
			failures.push(`renderer cannot import process or core implementation: ${specifier}`);
		if (file.startsWith(features) && target.startsWith(features) &&
			file.slice(features.length).split(sep)[0] !== target.slice(features.length).split(sep)[0] &&
			!typeOnly && basename(target) !== "index.js")
			failures.push(`use the other feature's entry point: ${specifier}`);
		if (file.endsWith(".ts") && !specifier.endsWith(".ts")) failures.push(`TypeScript relative imports must end in .ts: ${specifier}`);
		if (!existsSync(target)) failures.push(`missing local module: ${specifier}`);
		return failures;
	}
	if (file.startsWith(renderer) && (isBuiltin(specifier) || specifier === "electron") && !typeOnly)
		failures.push(`renderer cannot import Node or Electron: ${specifier}`);
	if (isBuiltin(specifier)) return failures;
	if (specifier.startsWith("@earendil-works/pi-") || specifier.startsWith("@relay/") || specifier.includes("node_modules/") || specifier.startsWith("/"))
		failures.push(`use local modules or published npm aliases: ${specifier}`);
	if (file.startsWith(core) && specifier === "electron") failures.push("core cannot import Electron");
	const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	if (runtime && !Object.hasOwn(manifest.dependencies, name)) failures.push(`undeclared runtime dependency: ${specifier}`);
	const dependency = pi.get(name);
	if (dependency) {
		const entry = specifier === name ? "." : `.${specifier.slice(name.length)}`;
		const exported = Object.entries(dependency.exports ?? { ".": dependency.main }).find(([pattern]) => {
			if (!pattern.includes("*")) return pattern === entry;
			const [prefix, suffix] = pattern.split("*");
			return entry.startsWith(prefix) && entry.endsWith(suffix);
		});
		if (!exported) failures.push(`private dependency entry: ${specifier}`);
		else {
			const [pattern, conditions] = exported;
			const target = typeof conditions === "string" ? conditions : conditions.import;
			const [prefix, suffix] = pattern.split("*");
			const wildcard = pattern.includes("*") ? entry.slice(prefix.length, suffix ? -suffix.length : undefined) : "";
			if (!target || !existsSync(resolve(root, "node_modules", name, target.replace("*", wildcard))))
				failures.push(`no published runtime file: ${specifier}`);
		}
	}
	return failures;
}
