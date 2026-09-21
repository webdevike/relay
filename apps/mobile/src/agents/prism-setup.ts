/**
 * Prism's extra grammar files attach themselves to a global `Prism`. Import this module
 * before any `prismjs/components/*` import; ES module order guarantees it runs first.
 */
import { Prism } from "prism-react-renderer";

Object.assign(globalThis, { Prism });
