import { nativeAdapters } from "../runtimes/index.ts";
import { RelayApplication } from "./application.ts";
import { applicationDirectory } from "./paths.ts";
import { RelayServer } from "./server.ts";

const directory = applicationDirectory();
const server = new RelayServer(new RelayApplication(directory, nativeAdapters()), directory);
await server.start();
process.stdout.write(`Relay service ready: ${directory}\n`);
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	void server.close().then(
		() => process.exit(0),
		(error: unknown) => {
			process.stderr.write(`${String(error)}\n`);
			process.exit(1);
		},
	);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
