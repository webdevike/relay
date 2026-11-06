// Crops: a rectangle of one image, cut locally by ffmpeg (no AI). The spec's `params` give the
// rectangle as fractions of the source (`x`, `y`, `w`, `h`); the output keeps the source's type
// (JPEG stays JPEG, everything else becomes PNG so transparency survives).

import { join } from "node:path";
import type { StudioBackend } from "@relay/protocol";
import { findTool } from "../drops/video";
import { BACKEND_BASE, cropBox } from "./backends";
import type { StudioMedia } from "./media";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "./runner";

export class CropRunner implements StudioRunner {
  constructor(
    private readonly media: StudioMedia,
    /** ffmpeg's path, null when it is not installed. */
    private readonly ffmpeg: () => string | null = () => findTool("ffmpeg"),
  ) {}

  describe(): Promise<StudioBackend> {
    if (this.ffmpeg() === null) return Promise.resolve({ ...BACKEND_BASE.crop, available: false, reason: "ffmpeg not found (brew install ffmpeg)" });
    return Promise.resolve({ ...BACKEND_BASE.crop, available: true });
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const source = input.refs[0];
    if (source === undefined) throw new Error("Crop needs an image");
    const jpeg = /\.jpe?g$/i.test(source);
    const out = join(input.workDir, jpeg ? "out.jpg" : "out.png");
    input.note("Cropping");
    await this.media.crop(source, out, cropBox(input.spec.params ?? {}));
    return { path: out, mimeType: jpeg ? "image/jpeg" : "image/png" };
  }
}
