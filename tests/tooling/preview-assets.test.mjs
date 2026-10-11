import assert from "node:assert/strict";
import { test } from "node:test";
import { previewAssets, previewAsset } from "../../scripts/preview-assets.mjs";

test("preview serves nested features, styles, and icons while restricting other paths", async () => {
	const assets = await previewAssets(new URL("../../src/renderer/", import.meta.url));
	for (const path of ["features/conversation/composer.js", "features/accounts/popovers.css", "styles/icons.css", "icons/plus.svg"])
		assert.equal(previewAsset(`/${path}?v=1`, assets), path);
	assert.equal(previewAsset("/", assets), "index.html");
	for (const path of ["/../package.json", "/%2e%2e/package.json", "/ui/../../AGENTS.md", "/globals.d.ts", "/icons/LICENSE", "/%", "/features/missing.js"])
		assert.equal(previewAsset(path, assets), undefined, path);
});
