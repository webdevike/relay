import "@xyflow/react/dist/base.css";
import "./style.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { env, loadIdentity } from "./room";

// Light or dark: `theme=` from the embedding app wins, else the system setting (live).
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
	document.documentElement.dataset["theme"] = env.theme ?? (dark.matches ? "dark" : "light");
};
applyTheme();
dark.addEventListener("change", applyTheme);
document.documentElement.dataset["embed"] = env.embed;

const root = document.getElementById("root");
if (root) {
	const state = await loadIdentity();
	createRoot(root).render(<App state={state} />);
}
