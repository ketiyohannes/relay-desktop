import { copyFile, mkdir, writeFile } from "node:fs/promises";

const names = ["moon", "sun", "plus", "folder-open", "chat-circle", "clock-counter-clockwise", "gear-six", "caret-right", "arrow-up", "square", "x", "code", "terminal", "check-circle", "arrows-clockwise", "warning-circle", "note-pencil", "sidebar-simple"];
const target = new URL("../ui/icons/", import.meta.url);
await mkdir(target, { recursive: true });
for (const name of names) {
	const source = new URL(import.meta.resolve(`@phosphor-icons/core/assets/regular/${name}.svg`));
	await copyFile(source, new URL(`${name}.svg`, target));
}
const source = new URL(import.meta.resolve("@phosphor-icons/core/assets/regular/plus.svg"));
await copyFile(new URL("../../LICENSE", source), new URL("LICENSE", target));
await writeFile(new URL("../ui/icons.css", import.meta.url), `/* Generated from @phosphor-icons/core 2.1.1. Run npm run icons --workspace packages/desktop. */\n.icon { display: inline-block; width: 16px; height: 16px; flex-shrink: 0; background: currentColor; mask: var(--icon-url) center / contain no-repeat; }\n${names.map((name) => `.icon-${name} { --icon-url: url('icons/${name}.svg'); }`).join("\n")}\n`);
