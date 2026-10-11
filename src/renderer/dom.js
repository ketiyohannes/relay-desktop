/** @template {string} S @param {S} selector @returns {SelectedElement<S>} */
export function query(selector) {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`Missing UI element: ${selector}`);
	return /** @type {SelectedElement<S>} */ (/** @type {unknown} */ (element));
}
