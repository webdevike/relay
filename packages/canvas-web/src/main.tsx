import "@xyflow/react/dist/base.css";
import "./style.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { env, loadIdentity } from "./room";
import "./page-theme";

// Light or dark (viewer toggle, else the embedding app, else the system) is applied by page-theme.
document.documentElement.dataset["embed"] = env.embed;

const root = document.getElementById("root");
if (root) {
  const state = await loadIdentity();
  createRoot(root).render(<App state={state} />);
}
