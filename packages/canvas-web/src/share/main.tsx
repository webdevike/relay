import "../tokens.css";
import "../widget.css";
import "./share.css";
import { createRoot } from "react-dom/client";
import type { SharedBoard } from "../../../protocol/src/index";
import { type Scheme, SharePage } from "./SharePage";

/** The id of the JSON script the host fills with the page's `SharedBoard`. */
const DATA_ID = "relay-share";

const scheme: Scheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset["theme"] = scheme;

// What Mantine tile code may call: no chat behind a shared page, links open in a new tab.
Object.assign(window, {
  relay: Object.freeze({
    theme: null,
    colorScheme: scheme,
    reply: () => false,
    open: (url: unknown) => {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
      window.open(url, "_blank", "noopener");
      return true;
    },
  }),
});

// Every web link leaves the page in a new tab, so the shared page stays where it is.
document.addEventListener(
  "click",
  (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link === null) return;
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener");
  },
  true,
);

const data = document.getElementById(DATA_ID)?.textContent;
const root = document.getElementById("root");
if (data && root)
  createRoot(root).render(<SharePage board={JSON.parse(data) as SharedBoard} scheme={scheme} />);
