import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepareUi } from "./prepare-ui.mjs";

if (process.platform !== "darwin") throw new Error("This packaging command currently targets macOS only.");
const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const electronPackage = dirname(require.resolve("electron/package.json"));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const nodeVersion = "26.0.0";
const output = join(root, "dist", `relay-desktop-${manifest.version}-${process.platform}-${process.arch}`);
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, ".package-"));
const bundle = join(staging, "Relay Desktop.app");
try {
	// Copy the already installed runtime; never implicitly execute Electron's install script.
	await cp(join(electronPackage, "dist", "Electron.app"), bundle, { recursive: true, verbatimSymlinks: true });
	const resources = join(bundle, "Contents", "Resources");
	const application = join(resources, "app");
	await mkdir(application);
	await writeFile(join(application, "package.json"), JSON.stringify({
		...manifest, main: "apps/desktop/.runtime/main.mjs", scripts: {},
	}, null, 2));
	await cp(join(root, "package-lock.json"), join(application, "package-lock.json"));
	for (const workspace of manifest.workspaces) {
		await mkdir(join(application, workspace), { recursive: true });
		await cp(join(root, workspace, "package.json"), join(application, workspace, "package.json"));
	}
	await cp(join(root, "packages/core/src"), join(application, "packages/core/src"), { recursive: true });
	await mkdir(join(application, "apps/desktop/src"), { recursive: true });
	await cp(join(root, "apps/desktop/src/worker.ts"), join(application, "apps/desktop/src/worker.ts"));
	await prepareUi();
	await cp(join(root, "apps/desktop/ui"), join(application, "apps/desktop/ui"), { recursive: true });
	await mkdir(join(application, "apps/desktop/.runtime"), { recursive: true });
	for (const [name, format, extension] of [["main", "esm", "mjs"], ["preload", "cjs", "cjs"]])
		await build({
			entryPoints: [join(root, `apps/desktop/src/${name}.ts`)],
			outfile: join(application, `apps/desktop/.runtime/${name}.${extension}`),
			bundle: true, platform: "node", format, external: ["electron"],
		});
	const npm = process.env.npm_execpath;
	if (!npm) throw new Error("Run packaging with npm run build:desktop using Node >=22.19.");
	execFileSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: application, stdio: "inherit",
	});
	await mkdir(join(resources, "runtime"));
	const archiveName = `node-v${nodeVersion}-darwin-${process.arch}.tar.gz`;
	const archive = join(staging, archiveName);
	const releaseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
	execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", `${releaseUrl}/${archiveName}`, "--output", archive], { stdio: "inherit" });
	const checksums = execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", `${releaseUrl}/SHASUMS256.txt`], { encoding: "utf8" });
	const expected = checksums.split("\n").find((line) => line.endsWith(`  ${archiveName}`))?.split(" ")[0];
	if (!expected || createHash("sha256").update(await readFile(archive)).digest("hex") !== expected)
		throw new Error("Node archive checksum did not match the official release.");
	execFileSync("tar", ["-xzf", archive, "-C", staging]);
	const nodeRoot = join(staging, archiveName.slice(0, -7));
	await cp(join(nodeRoot, "bin/node"), join(resources, "runtime/node"));
	await cp(join(nodeRoot, "LICENSE"), join(resources, "runtime/LICENSE"));
	for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
		await cp(join(root, name), join(resources, name));
	const plist = join(bundle, "Contents/Info.plist");
	for (const [key, value] of [
		["CFBundleDisplayName", "Relay Desktop"], ["CFBundleName", "Relay Desktop"],
		["CFBundleIdentifier", "com.relay.desktop"], ["CFBundleShortVersionString", manifest.version],
		["CFBundleVersion", manifest.version], ["CFBundleExecutable", "Relay Desktop"],
	]) execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
	await rename(join(bundle, "Contents/MacOS/Electron"), join(bundle, "Contents/MacOS/Relay Desktop"));
	const frameworks = join(bundle, "Contents/Frameworks");
	for (const name of await readdir(frameworks)) {
		if (!name.startsWith("Electron Helper") || !name.endsWith(".app")) continue;
		const helperPlist = join(frameworks, name, "Contents/Info.plist");
		for (const key of ["CFBundleDisplayName", "CFBundleName"])
			execFileSync("/usr/bin/plutil", ["-replace", key, "-string", "Relay Desktop Helper", helperPlist]);
		execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier com.relay.desktop.${name.includes("Renderer") ? "renderer" : name.includes("GPU") ? "gpu" : name.includes("Plugin") ? "plugin" : "helper"}`, helperPlist]);
	}
	// Local ad-hoc signature: distribution signing/notarization requires the owner's Apple identity.
	execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
	execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
	const destination = join(output, "Relay Desktop.app");
	try {
		await rename(destination, join(staging, "previous.app"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await rename(bundle, destination);
	console.log(`Built ${destination}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
