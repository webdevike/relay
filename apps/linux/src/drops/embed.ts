// What `share` tells an agent to paste for a blob drop, by type. Relay desktop and the phone show
// images, video and audio from a markdown `![caption](/drops/<id>/<token>)`; a 3D model only renders
// in an openui `Model(...)` block (markdown shows a broken image); anything else has no inline form
// and goes as a link. The iPhone plays only H.264 video and no ogg/opus audio, so those get a warning
// with the ffmpeg line that fixes them.

import { extname } from "node:path";
import { isAudioMime, playsOnIphone } from "./audio";
import { isModel } from "./model";
import { isVideoMime } from "./video";

/** The re-encode that makes any video play on the iPhone (and stream: index first). */
export const IPHONE_VIDEO_FIX = "ffmpeg -i in -c:v libx264 -pix_fmt yuv420p -movflags +faststart -c:a aac out.mp4";

/** 3D formats nothing in Relay renders; only GLB/GLTF has a viewer. */
const OTHER_3D: Readonly<Record<string, true>> = { ".stl": true, ".obj": true, ".fbx": true, ".usdz": true, ".usd": true, ".ply": true, ".3mf": true, ".dae": true, ".3ds": true, ".blend": true };

const CONVERT_3D =
  "warning: Relay only renders 3D as GLB in an openui Model block; convert first (e.g. bun -e or python trimesh: trimesh.load('in.stl').export('out.glb')) and share the .glb";

export interface EmbedInput {
  readonly name: string;
  readonly mimeType: string;
  /** The drop's fetch path, `/drops/<id>/<token>`. */
  readonly path: string;
  /** The video stream's codec (`h264`, `hevc`, ...) when probed; undefined when unknown. */
  readonly codec?: string;
}

export interface Embed {
  /** What the `shared <kind> <id> <path>` line calls it (`model` only for GLB/GLTF, which has an embed). */
  readonly kind: "image" | "video" | "audio" | "model" | "file";
  /** Lines for stdout, ready to paste. */
  readonly lines: readonly string[];
  /** Lines for stderr (`warning:` / `note:`). */
  readonly warnings: readonly string[];
}

export function embedFor(file: EmbedInput): Embed {
  const caption = file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
  if (isModel(file.name, file.mimeType)) {
    return {
      kind: "model",
      lines: [
        "embed (3D models only render in an openui Model block; never as markdown ![..]):",
        "```openui",
        `root = Model(${JSON.stringify(file.path)}, ${JSON.stringify(caption)})`,
        "```",
      ],
      warnings: [],
    };
  }
  const markdown = `embed ![${caption}](${file.path})`;
  if (file.mimeType.startsWith("image/")) return { kind: "image", lines: [markdown], warnings: [] };
  if (isVideoMime(file.mimeType)) {
    const webm = file.mimeType === "video/webm" || extname(file.name).toLowerCase() === ".webm";
    const codec = file.codec?.toLowerCase();
    const why = webm ? "webm video" : codec !== undefined && codec !== "h264" ? `${codec} video` : null;
    return {
      kind: "video",
      lines: [markdown],
      warnings: why === null ? [] : [`warning: iPhone can't play ${why}; re-encode to mp4 H.264 and share that: ${IPHONE_VIDEO_FIX}`],
    };
  }
  if (isAudioMime(file.mimeType)) {
    return {
      kind: "audio",
      lines: [markdown],
      warnings: playsOnIphone(file.name) ? [] : ["warning: iPhone cannot play this format; convert to m4a or mp3 first (ffmpeg -i in.ogg -c:a aac out.m4a)"],
    };
  }
  // No markdown image for anything else: a PDF or STL pasted as `![..]` is a broken image everywhere.
  const other3d = OTHER_3D[extname(file.name).toLowerCase()] === true || file.mimeType.startsWith("model/");
  return {
    kind: "file",
    lines: [`link [${file.name.replace(/[[\]]/g, "")}](${file.path})`],
    warnings: [other3d ? CONVERT_3D : `note: ${file.mimeType} has no inline embed in Relay; it shows as a link`],
  };
}
