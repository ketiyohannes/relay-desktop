import { spawn } from "node:child_process";

if (process.argv[2] === "worker") {
	process.on("SIGTERM", () => {});
	process.stdout.write(`${process.pid}\n`);
	setInterval(() => {}, 1000);
} else {
	spawn(process.execPath, [import.meta.filename, "worker"], { stdio: ["ignore", "inherit", "inherit"] });
	setInterval(() => {}, 1000);
}
