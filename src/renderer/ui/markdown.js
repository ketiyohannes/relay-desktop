import { renderCode } from "./code-view.js";
import { node } from "./dom.js";
// Build DOM nodes from Markdown tokens. Model HTML and URLs never enter innerHTML.
export function markdown(container, tokens, depth = 0) {
	if (depth > 30) return;
	for (const token of tokens) {
		let element;
		if (token.type === "space") continue;
		if (token.type === "heading")
			element = node(/** @type {const} */ (["h1", "h2", "h3", "h4"])[Math.min(token.depth, 4) - 1]);
		else if (token.type === "paragraph") element = node("p");
		else if (token.type === "strong") element = node("strong");
		else if (token.type === "em") element = node("em");
		else if (token.type === "del") element = node("del");
		else if (token.type === "blockquote") element = node("blockquote");
		else if (token.type === "br") element = node("br");
		else if (token.type === "hr") element = node("hr");
		else if (token.type === "codespan") element = node("code", "", token.text);
		else if (token.type === "code") {
			element = node("pre", "message-code");
			renderCode(element, { path: `snippet.${(token.lang || "txt").split(/\s/)[0]}`, after: token.text }, "after");
		} else if (token.type === "list") {
			element = node(token.ordered ? "ol" : "ul");
			if (token.ordered && token.start) element.start = token.start;
			for (const item of token.items) {
				const row = node("li");
				markdown(row, item.tokens, depth + 1);
				element.append(row);
			}
		} else if (token.type === "link") {
			element = node("span", "markdown-link");
			try {
				const url = new URL(token.href);
				if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
					element = node("a");
					element.href = url.href;
					element.title = url.href;
					element.addEventListener("click", (event) => {
						event.preventDefault();
						window.relay?.openUrl(url.href);
					});
				}
			} catch {
				/* Relative and unsupported links are displayed as text. */
			}
		} else if (token.type === "table") {
			element = node("table");
			const heading = node("tr");
			for (const cell of token.header) {
				const th = node("th");
				markdown(th, cell.tokens, depth + 1);
				heading.append(th);
			}
			element.append(heading);
			for (const row of token.rows) {
				const tr = node("tr");
				for (const cell of row) {
					const td = node("td");
					markdown(td, cell.tokens, depth + 1);
					tr.append(td);
				}
				element.append(tr);
			}
		} else if (token.tokens) {
			markdown(container, token.tokens, depth + 1);
			continue;
		} else {
			container.append(document.createTextNode(token.text || token.raw || ""));
			continue;
		}
		if (token.tokens && !["list", "table"].includes(token.type)) markdown(element, token.tokens, depth + 1);
		container.append(element);
	}
}
