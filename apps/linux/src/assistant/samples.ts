// The pictures and sounds of a new assistant's setup interview, as drops the chat can load:
// avatar faces drawn with the shared DiceBear call (`assistantAvatarSvg`) and rasterized to PNG,
// and one voice sample per GPT-Live or pocket-tts voice. A sample is rendered once into
// `<cacheDir>/<engine>-<voice>.wav` and put in the drop box again only when its drop is gone; a
// face is put in once per seed and colors while its drop lasts.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AssistantPortrait, Drop, DropOrigin } from "@relay/protocol";
import { assistantAvatarSvg } from "@relay/portrait-motion";
import { z } from "zod";
import type { AvatarOffer } from "./admin";
import { avatarChoices, LIVE_VOICES, LOCAL_VOICES, SAMPLE_TEXT, voiceChoices, type VoiceChoice } from "./onboarding";

/** Pixels per side of a face. */
export const AVATAR_PX = 256;

/** What the samples need of the drop box. */
export interface SampleDrops {
  list(): readonly Drop[];
  putBlob(origin: DropOrigin, blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Drop;
}

export interface InterviewSamplesDeps {
  readonly drops: SampleDrops;
  /** Where rendered samples and the drop index live. */
  readonly cacheDir: string;
  /** SVG markup to PNG bytes of `px` square. */
  readonly rasterize: (svg: string, px: number) => Promise<Uint8Array>;
  /** Says `text` in GPT-Live voice `voice` as WAV bytes; null without an OpenAI key. */
  readonly speakLive: ((voice: string, text: string) => Promise<Uint8Array>) | null;
  /** Says `text` in pocket-tts voice `voice` as WAV bytes; null without pocket-tts. */
  readonly speakLocal: ((voice: string, text: string) => Promise<Uint8Array>) | null;
  readonly log: (line: string) => void;
}

const DropIndex = z.record(z.string(), z.string());

export class InterviewSamples {
  constructor(private readonly deps: InterviewSamplesDeps) {}

  /** The look question's OpenUI program for `offers` (from `AssistantRegistry.offerAvatars`). */
  async avatars(title: string, offers: readonly AvatarOffer[]): Promise<string> {
    const choices = await Promise.all(
      offers.map(async (offer) => ({ n: offer.n, path: await this.avatarDrop(offer.portrait) })),
    );
    return avatarChoices(title, choices);
  }

  /**
   * The voice question's OpenUI program: GPT-Live voices when the host has an OpenAI key (a live
   * call is what the phone places then), else pocket-tts voices; null when it has neither.
   */
  async voices(title: string): Promise<string | null> {
    const live = this.deps.speakLive;
    const local = this.deps.speakLocal;
    const engine = live !== null ? "live" : local !== null ? "local" : null;
    if (engine === null) return null;
    const voices: readonly string[] = engine === "live" ? LIVE_VOICES : LOCAL_VOICES;
    const settled = await Promise.allSettled(
      voices.map(async (voice): Promise<VoiceChoice> => ({ voice, engine, path: await this.voiceDrop(engine, voice) })),
    );
    const choices: VoiceChoice[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") choices.push(result.value);
      else this.deps.log(`voice sample ${voices[index] ?? "?"} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
    return choices.length === 0 ? null : voiceChoices(title, choices);
  }

  private async avatarDrop(portrait: AssistantPortrait): Promise<string> {
    const key = `avatar ${JSON.stringify([portrait.style, portrait.seed, portrait.options ?? {}, portrait.colors?.paper ?? null])}`;
    const known = this.knownDrop(key);
    if (known !== null) return known;
    const png = await this.deps.rasterize(assistantAvatarSvg(portrait), AVATAR_PX);
    return this.remember(key, this.deps.drops.putBlob("host", { name: `avatar-${portrait.seed}.png`, mimeType: "image/png", bytes: png }));
  }

  private async voiceDrop(engine: "live" | "local", voice: string): Promise<string> {
    const key = `voice ${engine} ${voice}`;
    const known = this.knownDrop(key);
    if (known !== null) return known;
    const file = join(this.deps.cacheDir, `${engine}-${voice}.wav`);
    let wav: Uint8Array;
    if (existsSync(file)) {
      wav = readFileSync(file);
    } else {
      const speak = engine === "live" ? this.deps.speakLive : this.deps.speakLocal;
      if (speak === null) throw new Error(`no ${engine} voices on this host`);
      wav = await speak(voice, SAMPLE_TEXT);
      mkdirSync(this.deps.cacheDir, { recursive: true });
      writeFileSync(file, wav);
    }
    return this.remember(key, this.deps.drops.putBlob("host", { name: `voice-${voice}.wav`, mimeType: "audio/wav", bytes: wav }));
  }

  /** The drop path stored for `key`, while that drop is still in the box. */
  private knownDrop(key: string): string | null {
    const path = this.index()[key];
    if (path === undefined) return null;
    return this.deps.drops.list().some((drop) => drop.file?.path === path) ? path : null;
  }

  private remember(key: string, drop: Drop): string {
    const path = drop.file?.path;
    if (path === undefined) throw new Error("the drop box kept no file");
    mkdirSync(this.deps.cacheDir, { recursive: true });
    writeFileSync(join(this.deps.cacheDir, "drops.json"), JSON.stringify({ ...this.index(), [key]: path }, null, 2));
    return path;
  }

  private index(): Record<string, string> {
    try {
      return DropIndex.parse(JSON.parse(readFileSync(join(this.deps.cacheDir, "drops.json"), "utf8")));
    } catch {
      return {};
    }
  }
}

const run = promisify(execFile);

/** SVG to PNG with what the OS has: `sips` on macOS, `rsvg-convert` elsewhere. */
export async function rasterizeSvg(svg: string, px: number): Promise<Uint8Array> {
  const open = /^<svg[^>]*>/.exec(svg)?.[0];
  if (open === undefined) throw new Error("not an SVG");
  const sized = svg.replace(open, open.replace(/\s(width|height)="[^"]*"/g, "").replace(/^<svg/, `<svg width="${String(px)}" height="${String(px)}"`));
  const scratch = mkdtempSync(join(tmpdir(), "relay-avatar-"));
  try {
    const source = join(scratch, "face.svg");
    const target = join(scratch, "face.png");
    writeFileSync(source, sized);
    if (process.platform === "darwin") await run("sips", ["-s", "format", "png", source, "--out", target]);
    else await run("rsvg-convert", ["-w", String(px), "-h", String(px), "-o", target, source]);
    return readFileSync(target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** GPT-Live voice samples through OpenAI's speech endpoint (the same voices as a live call). */
export function openAiSpeech(key: string, fetcher: typeof fetch = fetch): (voice: string, text: string) => Promise<Uint8Array> {
  return async (voice, text) => {
    const response = await fetcher("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: text, response_format: "wav" }),
    });
    if (!response.ok) throw new Error(`OpenAI speech ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** pocket-tts samples from its server (`POST /tts`, as calls use it). */
export function pocketSpeech(ttsUrl: string, fetcher: typeof fetch = fetch): (voice: string, text: string) => Promise<Uint8Array> {
  return async (voice, text) => {
    const form = new FormData();
    form.set("text", text);
    form.set("voice_url", voice);
    const response = await fetcher(`${ttsUrl}/tts`, { method: "POST", body: form });
    if (!response.ok) throw new Error(`pocket-tts ${String(response.status)}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}
