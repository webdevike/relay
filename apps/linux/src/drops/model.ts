// 3D model drops (.glb, .gltf). Clients upload them as '' or application/octet-stream (no browser or
// Bun mime table agrees on a type), so the host names them by extension: Relay clients pick the
// Model widget path by these types, and `share` prints a Model() block for them, never markdown.

import { extname } from "node:path";

const MODEL_TYPES: Readonly<Record<string, string>> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

/** The model type for `name`'s extension when `mimeType` says nothing more specific; `mimeType` otherwise. */
export function modelMimeOf(name: string, mimeType: string): string {
  if (mimeType !== "" && mimeType !== "application/octet-stream") return mimeType;
  return MODEL_TYPES[extname(name).toLowerCase()] ?? mimeType;
}

/** Whether `name` (by extension) or `mimeType` is a GLB/GLTF model. */
export function isModel(name: string, mimeType: string): boolean {
  return MODEL_TYPES[extname(name).toLowerCase()] !== undefined || mimeType === "model/gltf-binary" || mimeType === "model/gltf+json";
}
