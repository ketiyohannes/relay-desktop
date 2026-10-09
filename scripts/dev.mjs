import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepareUi } from "./prepare-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = fileURLToPath(new URL("../.runtime/", import.meta.url));
await mkdir(directory, { recursive: true });
await prepareUi();
await build({ entryPoints: [new URL("../src/main/index.ts", import.meta.url).pathname], outfile: `${directory}/main.mjs`, bundle: true, platform: "node", format: "esm", external: ["electron"] });
await build({ entryPoints: [new URL("../src/preload/index.ts", import.meta.url).pathname], outfile: `${directory}/preload.cjs`, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
const require = createRequire(import.meta.url);
const runtimeNode = process.env.RELAY_NODE_PATH || process.execPath;
const nodeVersion = spawnSync(runtimeNode, ["--version"], { encoding: "utf8" });
const [major, minor] = (nodeVersion.stdout || "").trim().replace(/^v/, "").split(".").map(Number);
if (nodeVersion.error || !major || major < 22 || (major === 22 && minor < 19)) {
	console.error("Relay requires Node >=22.19. Set RELAY_NODE_PATH to a supported Node executable.");
	process.exit(1);
}
let electron;
// Electron 44's package entry runs install.js when the binary is absent.
// Resolve metadata only, so starting Relay never implicitly runs lifecycle scripts.
try {
	const packageDir = dirname(require.resolve("electron/package.json"));
	const relativePath = readFileSync(join(packageDir, "path.txt"), "utf8").trim();
	electron = join(packageDir, "dist", relativePath);
	if (!existsSync(electron)) throw new Error("Missing Electron executable");
}
catch {
	console.error("Electron binary is missing. Run node node_modules/electron/install.js from the repo root after approving its installation script.");
	process.exit(1);
}
const child = spawn(electron, [`${directory}/main.mjs`, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, RELAY_REPOSITORY: root, RELAY_NODE_PATH: runtimeNode } });
child.on("exit", (code) => process.exit(code ?? 1));
