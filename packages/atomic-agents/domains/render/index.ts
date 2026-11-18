/** 3D props: model an object in Blender, matching a reference image when given, and render it (the prop-render agent). The domain's public entry: code outside `domains/render/` imports only this file. */
export { Blender, blenderPack } from "./adapters/pack.ts";
export { RenderCompleted, RenderRequested } from "./schema.ts";
