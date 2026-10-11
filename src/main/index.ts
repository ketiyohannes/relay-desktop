import { type ChildProcess, fork } from "node:child_process";
import { realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { DesktopRequests } from "../core/desktop/requests.ts";
import type { DesktopCommand, DesktopLogin, DesktopState, DesktopUpdate } from "../core/desktop/types.ts";
import { applicationDirectory } from "../core/service/paths.ts";

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
const requests = new DesktopRequests();
let window: BrowserWindow;

function request(command: DesktopCommand): Promise<unknown> {
	if (!worker?.connected) return Promise.reject(new Error("Agent worker unavailable"));
	return requests.request(
		command,
		(id, command) => worker!.send({ id, command }),
		(message) => {
			if (!window.isDestroyed()) window.webContents.send("relay:error", message);
		},
	);
}

async function startDesktop(root: string): Promise<void> {
	app.setName("Relay Desktop");
	app.setPath("userData", process.env.RELAY_DATA_DIR || join(app.getPath("appData"), "Relay"));
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	app.on("second-instance", () => {
		if (window) {
			if (window.isMinimized()) window.restore();
			window.focus();
		}
	});
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
			preload: join(root, ".runtime/preload.cjs"),
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
	worker = fork(join(root, "src/main/worker.ts"), [join(app.getPath("userData"), "sessions")], {
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
			update?: DesktopUpdate;
			login?: DesktopLogin;
			result?: unknown;
			error?: string;
			tool?: string;
			input?: unknown;
		}) => {
			if (message.type === "login" && !window.isDestroyed()) window.webContents.send("relay:login", message.login);
			if (message.type === "response") {
				requests.complete(message.id, message.result, message.error);
			}
			if (message.type === "state" && !window.isDestroyed()) window.webContents.send("relay:state", message.state);
			if (message.type === "update" && !window.isDestroyed()) window.webContents.send("relay:update", message.update);
			if (message.type === "permission_closed" && !window.isDestroyed())
				window.webContents.send("relay:permission_closed", message.id);
			if (message.type === "permission" && !window.isDestroyed()) {
				window.webContents.send("relay:permission", { id: message.id, tool: message.tool, input: message.input });
			}
		},
	);
	worker.on("exit", () => {
		requests.disconnected();
		if (!window.isDestroyed()) window.webContents.send("relay:error", "Agent worker exited. Restart Relay.");
	});
	worker.on("error", (error) => {
		requests.disconnected();
		if (!window.isDestroyed()) window.webContents.send("relay:error", `Agent worker failed: ${error.message}`);
	});
	await window.loadFile(join(root, "src/renderer/index.html"));
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", () => worker?.kill());
}

// Return from ESM evaluation before waiting for Chromium's ready event.
void startDesktop(root).catch((error: unknown) => {
	process.stderr.write(`Relay startup failed: ${String(error)}\n`);
	app.quit();
});
