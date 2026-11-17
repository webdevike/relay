/** Diagrams: draw a described flow, loop, architecture or structure as one rendered image (the diagram agent). The domain's public entry: code outside `domains/diagram/` imports only this file. */
export { diagramPack } from "./adapters/pack.ts";
export { Renderer } from "./adapters/renderer.ts";
export { DiagramRendered, DiagramRequested } from "./schema.ts";
