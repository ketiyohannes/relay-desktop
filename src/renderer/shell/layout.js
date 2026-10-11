import { query as $ } from "../ui/dom.js";

export function installLayout() {
	const panels = [
		{
			element: "#navigation",
			toggle: "#sidebar-toggle",
			handle: "#left-resize",
			key: "relay.sidebarHidden",
			widthKey: "relay.sidebarWidth",
			variable: "--sidebar-width",
			label: "projects",
			width: Number(localStorage.getItem("relay.sidebarWidth")) || 240,
			min: 180,
			max: 420,
		},
		{
			element: "#inspector",
			toggle: "#details-toggle",
			handle: "#right-resize",
			key: "relay.inspectorHidden",
			widthKey: "relay.inspectorWidth",
			variable: "--details-width",
			label: "inspector",
			width: Number(localStorage.getItem("relay.inspectorWidth")) || 340,
			min: 280,
			max: 700,
		},
	];
	function renderPanels() {
		let budget = Math.max(460, window.innerWidth - 410 - 8);
		const visible = panels.filter((panel) => localStorage.getItem(panel.key) !== "true");
		for (const panel of panels) {
			const hidden = !visible.includes(panel);
			const otherMinimum = panels
				.slice(panels.indexOf(panel) + 1)
				.filter((item) => visible.includes(item))
				.reduce((sum, item) => sum + item.min, 0);
			const width = hidden ? 0 : Math.min(Math.max(panel.min, panel.width), panel.max, budget - otherMinimum);
			if (!hidden) budget -= width;
			document.documentElement.style.setProperty(panel.variable, `${width}px`);
			document.documentElement.style.setProperty(
				panel.handle === "#left-resize" ? "--left-rail" : "--right-rail",
				hidden ? "0px" : "4px",
			);
			$(panel.element).hidden = hidden;
			$(panel.handle).hidden = hidden;
			$(panel.toggle).setAttribute("aria-expanded", String(!hidden));
			$(panel.toggle).setAttribute("aria-label", `${hidden ? "Show" : "Hide"} ${panel.label}`);
			$(panel.handle).setAttribute("aria-valuemin", String(panel.min));
			$(panel.handle).setAttribute("aria-valuemax", String(panel.max));
			$(panel.handle).setAttribute("aria-valuenow", String(Math.round(width)));
		}
	}
	for (const [index, panel] of panels.entries()) {
		$(panel.toggle).addEventListener("click", () => {
			localStorage.setItem(panel.key, String(!$(panel.element).hidden));
			renderPanels();
		});
		const handle = $(panel.handle);
		handle.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const start = event.clientX;
			const width = $(panel.element).getBoundingClientRect().width;
			handle.setPointerCapture(event.pointerId);
			const move = (next) => {
				panel.width = Math.max(panel.min, Math.min(panel.max, width + (next.clientX - start) * (index === 0 ? 1 : -1)));
				renderPanels();
			};
			const finish = () => {
				panel.width = $(panel.element).getBoundingClientRect().width;
				localStorage.setItem(panel.widthKey, String(panel.width));
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("lostpointercapture", finish);
				document.body.classList.remove("resizing");
			};
			document.body.classList.add("resizing");
			handle.addEventListener("pointermove", move);
			handle.addEventListener("lostpointercapture", finish);
		});
		handle.addEventListener("keydown", (event) => {
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			panel.width =
				event.key === "Home"
					? panel.min
					: event.key === "End"
						? panel.max
						: Math.max(
								panel.min,
								Math.min(
									panel.max,
									$(panel.element).getBoundingClientRect().width +
										(event.key === "ArrowRight" ? 20 : -20) * (index === 0 ? 1 : -1),
								),
							);
			renderPanels();
			panel.width = $(panel.element).getBoundingClientRect().width;
			localStorage.setItem(panel.widthKey, String(panel.width));
		});
	}
	window.addEventListener("resize", renderPanels);
	renderPanels();

	return {};
}
