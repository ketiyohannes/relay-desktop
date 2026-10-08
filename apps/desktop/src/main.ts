import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { DesktopCommand, DesktopLogin, DesktopState } from "@relay/core/desktop/types";
import { applicationDirectory } from "@relay/core/service/paths";
import { app, BrowserWindow, ipcMain, shell } from "electron";

const root = app.isPackaged ? app.getAppPath() : process.env.RELAY_REPOSITORY;
if (!root) throw new Error("Launch Relay with npm run desktop");
if (app.isPackaged) {
	process.env.RELAY_NODE_PATH ||= join(process.resourcesPath, "runtime", "node");
	process.env.PATH = [
		dirname(process.env.RELAY_NODE_PATH),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		process.env.PATH || "",
	].join(delimiter);
}
let worker: ChildProcess | undefined;
const requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let window: BrowserWindow;

function request(command: DesktopCommand): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!worker?.connected) return reject(new Error("Agent worker unavailable"));
		const id = randomUUID();
		const timer = setTimeout(() => {
			requests.delete(id);
			reject(new Error("Agent worker timed out"));
		}, 30000);
		requests.set(id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		});
		worker.send({ id, command });
	});
}

async function startDesktop(root: string): Promise<void> {
	app.setName("Relay Desktop");
	app.setPath("userData", process.env.RELAY_DATA_DIR || join(app.getPath("appData"), "Relay"));
	await app.whenReady();
	window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 1050,
		minHeight: 680,
		title: "Relay Desktop",
		backgroundColor: "#fafafa",
		titleBarStyle: "hiddenInset",
		webPreferences: {
			preload: join(root, "apps/desktop/.runtime/preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	ipcMain.handle("relay:command", async (event, command: DesktopCommand) => {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
			throw new Error("Untrusted frame");
		if (!command || typeof command.type !== "string") throw new Error("Invalid command");
		return request(command);
	});
	ipcMain.handle("relay:reveal", async (event, path: string) => {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
			throw new Error("Untrusted frame");
		const target = await realpath(path);
		shell.showItemInFolder(target);
	});
	ipcMain.handle("relay:permission", (event, id: string, allowed: boolean, allowRun: boolean) => {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
			throw new Error("Untrusted frame");
		worker?.send({ id, allowed: allowed === true, allowRun: allowRun === true });
	});
	ipcMain.handle("relay:external", async (event, value: string) => {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
			throw new Error("Untrusted frame");
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
			throw new Error("Unsupported link");
		await shell.openExternal(url.toString());
	});
	worker = fork(join(root, "apps/desktop/src/worker.ts"), [join(app.getPath("userData"), "sessions")], {
		execPath: process.env.RELAY_NODE_PATH || "node",
		execArgv: [],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		// Account credentials stay in the child; the renderer receives only account metadata.
		env: { ...process.env, RELAY_APP_DIR: applicationDirectory() },
	});
	worker.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
	worker.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
	worker.on(
		"message",
		(message: {
			type: string;
			id: string;
			state?: DesktopState;
			login?: DesktopLogin;
			result?: unknown;
			error?: string;
			tool?: string;
			input?: unknown;
		}) => {
			if (message.type === "login" && !window.isDestroyed()) window.webContents.send("relay:login", message.login);
			if (message.type === "response") {
				const pending = requests.get(message.id);
				requests.delete(message.id);
				if (message.error) pending?.reject(new Error(message.error));
				else pending?.resolve(message.result);
			}
			if (message.type === "state" && !window.isDestroyed()) window.webContents.send("relay:state", message.state);
			if (message.type === "permission_closed" && !window.isDestroyed())
				window.webContents.send("relay:permission_closed", message.id);
			if (message.type === "permission" && !window.isDestroyed()) {
				window.webContents.send("relay:permission", { id: message.id, tool: message.tool, input: message.input });
			}
		},
	);
	worker.on("exit", () => {
		for (const pending of requests.values()) pending.reject(new Error("Agent worker exited"));
		requests.clear();
		if (!window.isDestroyed()) window.webContents.send("relay:error", "Agent worker exited. Restart Relay.");
	});
	worker.on("error", (error) => {
		for (const pending of requests.values()) pending.reject(error);
		requests.clear();
		if (!window.isDestroyed()) window.webContents.send("relay:error", `Agent worker failed: ${error.message}`);
	});
	await window.loadFile(join(root, "apps/desktop/ui/index.html"));
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", () => worker?.kill());
}

// Return from ESM evaluation before waiting for Chromium's ready event.
void startDesktop(root).catch((error: unknown) => {
	process.stderr.write(`Relay startup failed: ${String(error)}\n`);
	app.quit();
});
