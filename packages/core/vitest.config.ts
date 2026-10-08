import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/desktop/**/*.test.ts"],
	},
});
