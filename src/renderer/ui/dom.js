/** @template {string} S @param {S} selector @returns {SelectedElement<S>} */
export function query(selector) {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`Missing UI element: ${selector}`);
	return /** @type {SelectedElement<S>} */ (/** @type {unknown} */ (element));
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag */
export function node(tag, className = "", text = undefined) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}
export function button(text, onClick, className = "") {
	const element = node("button", className, text);
	element.type = "button";
	element.addEventListener("click", onClick);
	return element;
}
export function icon(name) {
	const element = node("span", `icon icon-${name}`);
	element.setAttribute("aria-hidden", "true");
	return element;
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag */
export const textElement = (tag, text, className = "") => {
	const item = document.createElement(tag);
	item.textContent = text;
	item.className = className;
	return item;
};
