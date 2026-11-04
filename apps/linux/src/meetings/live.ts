// One recording's live transcript: the worker's drafts and finals as LiveLines (drafts replaced by
// id, an empty final removes the line's text), with the echo filter on the mic. A mic line is
// checked against the call audio of ECHO_WINDOW_MS around it when it arrives and again when later
// call lines come in (the app's final can land after the mic's); it only ever shrinks.

import { MEETING_SAMPLE_RATE, type LiveLine } from "@relay/protocol";
import type { WorkerLine } from "./asr";
import { ECHO_WINDOW_MS, ownSpeech, triples } from "./echo";

const MS_PER_SAMPLE = 1000 / MEETING_SAMPLE_RATE;

export class LiveTranscript {
  private readonly lines = new Map<string, LiveLine>();
  /** What the worker heard on each mic line before the echo filter. */
  private readonly heard = new Map<string, string>();
  rev = 0;

  constructor(
    initial: readonly LiveLine[],
    private readonly speakers: { mic: string; app: () => string },
  ) {
    for (const l of initial) this.lines.set(l.id, l);
  }

  all(): LiveLine[] {
    return [...this.lines.values()].sort((a, b) => a.startMs - b.startMs);
  }

  /** Applies one worker line; answers the lines that changed (empty when nothing did). */
  apply(w: WorkerLine): LiveLine[] {
    const prior = this.lines.get(w.id);
    // Finals never change; a draft arriving after its final is stale.
    if (prior?.final === true) return [];
    const line: LiveLine = {
      id: w.id,
      track: w.track,
      speaker: w.track === "mic" ? this.speakers.mic : this.speakers.app(),
      startMs: Math.round(w.start * MS_PER_SAMPLE),
      endMs: Math.round(w.end * MS_PER_SAMPLE),
      text: w.text,
      final: w.final,
    };
    const changed: LiveLine[] = [];
    if (line.track === "mic") {
      this.heard.set(line.id, line.text);
      changed.push(this.filtered(line));
    } else {
      this.lines.set(line.id, line);
      changed.push(line);
      // Mic lines near this call line may hold its echo.
      for (const mic of this.lines.values()) {
        if (mic.track !== "mic" || mic.echo === true || !near(mic, line)) continue;
        const again = this.filtered(mic);
        if (again.text !== mic.text || again.echo !== mic.echo) changed.push(again);
      }
    }
    for (const l of changed) this.lines.set(l.id, l);
    if (changed.length > 0) this.rev += 1;
    return changed;
  }

  /** A mic line with the call's three-word runs around it taken out (more call text only drops more). */
  private filtered(mic: LiveLine): LiveLine {
    const text = this.heard.get(mic.id) ?? mic.text;
    const call = new Set<string>();
    for (const l of this.lines.values())
      if (l.track === "app" && near(mic, l)) for (const t of triples(l.text)) call.add(t);
    const own = ownSpeech(text, call);
    const rest: LiveLine = {
      id: mic.id,
      track: mic.track,
      speaker: mic.speaker,
      startMs: mic.startMs,
      endMs: mic.endMs,
      text: mic.text,
      final: mic.final,
    };
    return own.trim() === "" && text.trim() !== ""
      ? { ...rest, text, echo: true }
      : { ...rest, text: own };
  }

  /** Renames the call side's speaker on every line (a 1:1's name arrived from the calendar). */
  renameApp(name: string): LiveLine[] {
    const changed: LiveLine[] = [];
    for (const l of this.lines.values()) {
      if (l.track === "app" && l.speaker !== name) {
        const next = { ...l, speaker: name };
        this.lines.set(l.id, next);
        changed.push(next);
      }
    }
    if (changed.length > 0) this.rev += 1;
    return changed;
  }
}

function near(mic: LiveLine, app: LiveLine): boolean {
  return app.endMs >= mic.startMs - ECHO_WINDOW_MS && app.startMs <= mic.endMs + ECHO_WINDOW_MS;
}
