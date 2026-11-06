// Local SAM 2.1 (facebook/sam2.1-hiera-large, transformers format, from the Hugging Face cache; on the
// CPU) for the `sam` backend's `cutout` model (the subject, or a picked segment, on a transparent
// background) and the Studio `segment` op (the objects in an image, each a mask and a cutout). The
// python that runs it lives below as a string and is written to a scratch dir per run, so the host
// bundle needs no extra files; any python with torch, transformers and Pillow will do
// (RELAY_STUDIO_SAM_PYTHON). The model is read from the cache only (HF_HUB_OFFLINE), never downloaded.

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_STUDIO_SEGMENTS, type StudioBackend } from "@relay/protocol";
import { BACKEND_BASE } from "./backends";
import { LTX_KILL_GRACE_MS, runProcessGroup } from "./ltx";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "./runner";

export const SAM_MODEL = "facebook/sam2.1-hiera-large";
const STATUS_LINE = /^\[sam\] (.+)$/;
const ERROR_LINE = /^\[sam\] error: (.+)$/;

/** One object SAM found, as files in the segment op's out dir. */
export interface SamSegmentFile {
  /** "Background", "Subject" or "Object N": SAM names nothing, so these come from the mask's shape. */
  readonly label: string;
  /** Bounding box, fractions of the image: x, y, width, height. */
  readonly box: [number, number, number, number];
  /** Share of the image it covers, 0 to 1. */
  readonly area: number;
  /** Absolute path: grayscale PNG the size of the image, white = the object. */
  readonly mask: string;
  /** Absolute path: RGBA PNG of the object on transparency, cut to its box. */
  readonly cutout: string;
}

const fraction = z.number().min(0).max(1);
const SegmentsFile = z.object({
  segments: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        box: z.tuple([fraction, fraction, fraction, fraction]),
        area: fraction,
        mask: z.string().regex(/^[\w.-]+$/),
        cutout: z.string().regex(/^[\w.-]+$/),
      }),
    )
    .max(MAX_STUDIO_SEGMENTS),
});

export interface SamPaths {
  /** A python with torch, transformers (Sam2Model) and Pillow. */
  readonly python: string;
  /** The model's `snapshots` dir in the Hugging Face cache. */
  readonly snapshots: string;
}

export function defaultSamPaths(env: NodeJS.ProcessEnv = process.env): SamPaths {
  const hfHome = env["HF_HOME"] ?? join(homedir(), ".cache", "huggingface");
  return {
    python: env["RELAY_STUDIO_SAM_PYTHON"] ?? join(homedir(), ".local", "share", "hades-fit", "bin", "python"),
    snapshots: join(hfHome, "hub", `models--${SAM_MODEL.replace("/", "--")}`, "snapshots"),
  };
}

interface SamRunOptions {
  readonly signal?: AbortSignal;
  /** Each status line the script prints ("Finding objects (2 of 4)"). */
  readonly note?: (text: string) => void;
  readonly graceMs?: number;
}

/**
 * Runs the script with `args` in its own process group, offline. Rejects with the script's own one-line
 * error when it printed one, else runProcessGroup's reason ("Cancelled" once `signal` aborts).
 */
async function runSam(python: string, args: readonly string[], options: SamRunOptions): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "relay-sam-"));
  const script = join(dir, "sam.py");
  let failure: string | undefined;
  try {
    await writeFile(script, SAM_SCRIPT);
    await runProcessGroup([python, script, ...args], {
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false", PYTHONUNBUFFERED: "1" },
      signal: options.signal ?? new AbortController().signal,
      graceMs: options.graceMs ?? LTX_KILL_GRACE_MS,
      onLine: (line) => {
        const error = ERROR_LINE.exec(line);
        if (error !== null) failure = error[1];
        else {
          const status = STATUS_LINE.exec(line);
          if (status?.[1] !== undefined) options.note?.(status[1]);
        }
      },
    });
  } catch (error) {
    if (failure !== undefined && options.signal?.aborted !== true) throw new Error(failure);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * SAM 2.1's objects in `image`, largest first (at most MAX_STUDIO_SEGMENTS): a mask and a cutout PNG each,
 * written to `outDir`. Rejects with a one-line reason, or "Cancelled" once `signal` aborts.
 */
export async function segmentImage(opts: {
  readonly python: string;
  readonly image: string;
  readonly outDir: string;
  readonly signal?: AbortSignal;
  readonly note?: (text: string) => void;
  readonly graceMs?: number;
}): Promise<SamSegmentFile[]> {
  await runSam(opts.python, ["segments", opts.image, opts.outDir, String(MAX_STUDIO_SEGMENTS)], opts);
  const listed = SegmentsFile.safeParse(JSON.parse(await readFile(join(opts.outDir, "segments.json"), "utf8").catch(() => "null")));
  if (!listed.success) throw new Error("SAM 2.1 finished without a readable list of objects");
  return listed.data.segments.map((segment) => ({ ...segment, mask: join(opts.outDir, segment.mask), cutout: join(opts.outDir, segment.cutout) }));
}

export class SamRunner implements StudioRunner {
  constructor(
    private readonly paths: SamPaths = defaultSamPaths(),
    private readonly graceMs = LTX_KILL_GRACE_MS,
  ) {}

  describe(): Promise<StudioBackend> {
    const down = (reason: string): StudioBackend => ({ ...BACKEND_BASE.sam, available: false, reason });
    if (!existsSync(this.paths.python))
      return Promise.resolve(down(`SAM 2.1 is not set up on this host (no python at ${this.paths.python}; set RELAY_STUDIO_SAM_PYTHON)`));
    const cached = existsSync(this.paths.snapshots) && readdirSync(this.paths.snapshots).length > 0;
    if (!cached) return Promise.resolve(down(`SAM 2.1 is not set up on this host (${SAM_MODEL} is not in the Hugging Face cache)`));
    return Promise.resolve({ ...BACKEND_BASE.sam, available: true });
  }

  /** The cutout: `input.mask`'s object when the spec names a segment, else the subject SAM finds. */
  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const source = input.refs[0];
    if (source === undefined) throw new Error("SAM 2.1 needs an image");
    const out = join(input.workDir, "out.png");
    await runSam(this.paths.python, ["cutout", source, out, ...(input.mask === undefined ? [] : [input.mask])], {
      signal: input.signal,
      note: input.note,
      graceMs: this.graceMs,
    });
    if (!existsSync(out)) throw new Error("SAM 2.1 finished without writing the cutout");
    return { path: out, mimeType: "image/png" };
  }

  /** The `segment` op: SAM 2.1's objects in `image`, files in `outDir`. */
  segment(image: string, outDir: string, signal: AbortSignal): Promise<SamSegmentFile[]> {
    return segmentImage({ python: this.paths.python, image, outDir, signal, graceMs: this.graceMs });
  }
}

/** The python sam.ts runs (see its header for the commands and files). */
export const SAM_SCRIPT = `# Relay Studio's SAM 2.1 (facebook/sam2.1-hiera-large from the Hugging Face cache, on the CPU).
# apps/linux/src/studio/sam.ts writes this file to a scratch dir and runs it:
#   sam.py segments IMAGE OUTDIR MAX   the objects SAM finds by itself, largest first, at most MAX:
#                                      segment-N-mask.png (grayscale, the image's size, white = the object),
#                                      segment-N-cutout.png (the object on transparency, cut to its box),
#                                      segments.json {"segments": [{label, box, area, mask, cutout}]}
#   sam.py cutout IMAGE OUT [MASK]     the subject, or MASK's white part, on a transparent background (PNG)
# SAM names nothing: objects are found by prompting a point grid, then labeled from their shape alone
# ("Background", "Subject", "Object N"). Status lines go to stderr as "[sam] ...", a failure as "[sam] error: ...".
import json
import os
import sys

MODEL = 'facebook/sam2.1-hiera-large'
GRID = 16  # prompt points per side
BATCH = 64  # prompts per mask decoder pass
MIN_SCORE = 0.7  # SAM's own guess of the mask's IoU
MIN_STABILITY = 0.85  # the mask barely moves when its threshold does
SAME_IOU = 0.7  # a mask overlapping a better one this much is the same object
MIN_AREA = 0.004
MAX_AREA = 0.97
SUBJECT_MIN_AREA = 0.03
EDGE_SHARE = 0.3  # a mask touches a border when it covers this much of it


class Failure(Exception):
    pass


def say(text):
    print('[sam] ' + text, file=sys.stderr, flush=True)


def open_image(path):
    from PIL import Image, ImageOps
    return ImageOps.exif_transpose(Image.open(path)).convert('RGBA')


def proposals(image):
    """Low-res mask logits (n, 256, 256) and SAM's IoU guesses (n,): three masks per grid point."""
    import torch
    from transformers import Sam2Model, Sam2Processor
    say('Loading SAM 2.1')
    processor = Sam2Processor.from_pretrained(MODEL)
    model = Sam2Model.from_pretrained(MODEL).eval()
    rgb = image.convert('RGB')
    width, height = rgb.size
    points = [[(i + 0.5) * width / GRID, (j + 0.5) * height / GRID] for j in range(GRID) for i in range(GRID)]
    starts = range(0, len(points), BATCH)
    logits, scores = [], []
    with torch.inference_mode():
        say('Reading the picture')
        embeddings = model.get_image_embeddings(processor(images=rgb, return_tensors='pt')['pixel_values'])
        for n, start in enumerate(starts):
            say('Finding objects (%d of %d)' % (n + 1, len(starts)))
            chunk = points[start:start + BATCH]
            prompt = processor(
                input_points=[[[point] for point in chunk]],
                input_labels=[[[1] for _ in chunk]],
                original_sizes=[[height, width]],
                return_tensors='pt',
            )
            out = model(
                image_embeddings=embeddings,
                input_points=prompt['input_points'],
                input_labels=prompt['input_labels'],
                multimask_output=True,
            )
            logits.append(out.pred_masks[0].flatten(0, 1).float())
            scores.append(out.iou_scores[0].flatten().float())
    return torch.cat(logits), torch.cat(scores)


def pick(logits, scores, limit):
    """The distinct good masks: confident, stable, neither tiny nor nearly everything, none mostly a better
    one; the limit largest, largest first."""
    flat = (logits > 0).flatten(1)
    area = flat.float().mean(1)
    stability = (logits > 1).flatten(1).sum(1).float() / (logits > -1).flatten(1).sum(1).clamp(min=1).float()
    good = (scores >= MIN_SCORE) & (stability >= MIN_STABILITY) & (area >= MIN_AREA) & (area <= MAX_AREA)
    order = sorted(good.nonzero().flatten().tolist(), key=lambda i: -float(scores[i] + stability[i]))
    kept = []
    for i in order:
        if kept:
            others = flat[kept]
            inter = (others & flat[i]).sum(1).float()
            union = (others | flat[i]).sum(1).float().clamp(min=1)
            if bool((inter / union > SAME_IOU).any()):
                continue
        kept.append(i)
    kept.sort(key=lambda i: -float(area[i]))
    return kept[:limit]


def full_size(logit, size):
    import torch.nn.functional as F
    width, height = size
    return (F.interpolate(logit[None, None], (height, width), mode='bilinear', align_corners=False)[0, 0] > 0).numpy()


def shape(mask):
    """Box (fractions), area, how many borders it touches, and its centroid (fractions)."""
    import numpy as np
    height, width = mask.shape
    rows = np.flatnonzero(mask.any(1))
    cols = np.flatnonzero(mask.any(0))
    band = max(1, round(min(width, height) * 0.01))
    edges = [mask[:band].any(0).mean(), mask[-band:].any(0).mean(), mask[:, :band].any(1).mean(), mask[:, -band:].any(1).mean()]
    total = float(mask.sum())
    return {
        'pixels': (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1),
        'box': [cols[0] / width, rows[0] / height, (cols[-1] + 1 - cols[0]) / width, (rows[-1] + 1 - rows[0]) / height],
        'area': total / (width * height),
        'borders': sum(1 for edge in edges if edge >= EDGE_SHARE),
        'center': (float((mask.sum(0) * np.arange(width)).sum()) / total / width, float((mask.sum(1) * np.arange(height)).sum()) / total / height),
    }


def label(objects):
    """Names the objects (largest first) honestly: the largest touching three borders or more is the Background,
    the large one nearest the middle the Subject, the rest Object 1, 2, ... Returns the subject, or None."""
    background = next((o for o in objects if o['borders'] >= 3), None)

    def presence(o):
        off = min(1.0, ((o['center'][0] - 0.5) ** 2 + (o['center'][1] - 0.5) ** 2) ** 0.5 / 0.5)
        return o['area'] * (1 - off) ** 2

    large = [o for o in objects if o is not background and o['area'] >= SUBJECT_MIN_AREA and o['borders'] <= 2 and presence(o) > 0]
    subject = max(large, key=presence, default=None)
    count = 0
    for o in objects:
        if o is background:
            o['label'] = 'Background'
        elif o is subject:
            o['label'] = 'Subject'
        else:
            count += 1
            o['label'] = 'Object %d' % count
    return subject


def objects_in(image, limit):
    logits, scores = proposals(image)
    say('Saving objects')
    found = []
    for i in pick(logits, scores, limit):
        mask = full_size(logits[i], image.size)
        if mask.any():
            found.append(dict(shape(mask), mask=mask))
    found.sort(key=lambda o: -o['area'])
    return found


def save_mask(mask, path):
    from PIL import Image
    Image.fromarray(mask.astype('uint8') * 255).save(path)


def save_cutout(image, alpha, path, box=None):
    """The image with alpha (an L image) as its transparency, edges softened a little, cut to box when given."""
    from PIL import ImageChops, ImageFilter
    out = image.copy()
    out.putalpha(ImageChops.multiply(image.getchannel('A'), alpha.filter(ImageFilter.GaussianBlur(0.7))))
    (out.crop(box) if box is not None else out).save(path)


def segments(image_path, out_dir, limit):
    from PIL import Image
    image = open_image(image_path)
    found = objects_in(image, limit)
    label(found)
    listed = []
    for n, o in enumerate(found, 1):
        mask_name, cutout_name = 'segment-%d-mask.png' % n, 'segment-%d-cutout.png' % n
        save_mask(o['mask'], os.path.join(out_dir, mask_name))
        save_cutout(image, Image.fromarray(o['mask'].astype('uint8') * 255), os.path.join(out_dir, cutout_name), o['pixels'])
        listed.append({'label': o['label'], 'box': [float(v) for v in o['box']], 'area': float(o['area']), 'mask': mask_name, 'cutout': cutout_name})
    temp = os.path.join(out_dir, 'segments.json.part')
    with open(temp, 'w') as file:
        json.dump({'segments': listed}, file)
    os.replace(temp, os.path.join(out_dir, 'segments.json'))


def cutout(image_path, out, mask_path):
    from PIL import Image
    image = open_image(image_path)
    if mask_path is not None:
        say('Cutting out')
        alpha = Image.open(mask_path).convert('L').resize(image.size, Image.BILINEAR)
    else:
        found = objects_in(image, 24)
        subject = label(found) or next((o for o in found if o['label'] != 'Background'), None)
        if subject is None:
            raise Failure('SAM 2.1 found no subject in this picture')
        alpha = Image.fromarray(subject['mask'].astype('uint8') * 255)
    save_cutout(image, alpha, out)


def main(args):
    if len(args) == 4 and args[0] == 'segments':
        segments(args[1], args[2], int(args[3]))
    elif len(args) in (3, 4) and args[0] == 'cutout':
        cutout(args[1], args[2], args[3] if len(args) == 4 else None)
    else:
        raise Failure('usage: sam.py segments IMAGE OUTDIR MAX | sam.py cutout IMAGE OUT [MASK]')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:  # one line for the job, not a traceback
        say('error: %s' % (' '.join(str(error).split()) or type(error).__name__))
        sys.exit(1)
`;
