import type { DesktopCommand, DesktopLogin, DesktopState } from "@relay/core/desktop/types";
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("relay", {
	onLogin: (callback: (state: DesktopLogin) => void) => {
		ipcRenderer.on("relay:login", (_event, state: DesktopLogin) => callback(state));
	},
	command: (command: DesktopCommand) => ipcRenderer.invoke("relay:command", command),
	reveal: (path: string) => ipcRenderer.invoke("relay:reveal", path),
	permission: (id: string, allowed: boolean, allowRun = false) =>
		ipcRenderer.invoke("relay:permission", id, allowed, allowRun),
	openUrl: (url: string) => ipcRenderer.invoke("relay:external", url),
	onPermission: (callback: (request: { id: string; tool: string; input: unknown }) => void) => {
		ipcRenderer.on("relay:permission", (_event, request) => callback(request));
	},
	onPermissionClosed: (callback: (id: string) => void) => {
		ipcRenderer.on("relay:permission_closed", (_event, id: string) => callback(id));
	},
	onState: (callback: (state: DesktopState) => void) => {
		ipcRenderer.on("relay:state", (_event, state: DesktopState) => callback(state));
	},
	onError: (callback: (message: string) => void) => {
		ipcRenderer.on("relay:error", (_event, message: string) => callback(message));
	},
});
