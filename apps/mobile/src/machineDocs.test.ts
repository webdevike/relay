/**
 * Every XState machine of the phone has a page in `docs/state-machines/` (repo root) whose Mermaid
 * diagram is generated from the machine itself. This fails when a page is missing or its diagram is
 * stale; `pnpm machines:docs` (UPDATE_MACHINE_DOCS=1) rewrites the diagrams, and writes a new page
 * with a TODO where the plain-English lines go. Add a new machine to `MACHINES`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import { machineDiagram, newDoc, withDiagram } from "./lib/machineDiagram";
import { dictationMachine } from "./dictation/machine";
import { commandMachine } from "./connection/command.machine";
import { turnMachine } from "./state/turn.machine";
import { askMachine } from "./agents/ask.machine";
import { roomsRequestMachine } from "./rooms/roomsRequest.machine";
import { otaGateMachine } from "./lib/otaGate.machine";
import { composerShapeMachine } from "./agents/composerShape.machine";
import { chatFollowMachine } from "./ui/chatFollow.machine";
import { audioOwnerMachine } from "./dictation/audioOwner.machine";
import { targetStackMachine } from "./dictation/targetStack.machine";
import { sessionMachine } from "./connection/session.machine";
import { legacyCallMachine } from "./call/legacyCall.machine";

const MACHINES: readonly { file: string; title: string; machine: AnyStateMachine }[] = [
  { file: "dictation", title: "Dictation (hold-to-talk and tap runs)", machine: dictationMachine },
  { file: "command", title: "Reliable command lifecycle (phone to host)", machine: commandMachine },
  { file: "turn", title: "Sent assistant turn (echo bubble)", machine: turnMachine },
  { file: "ask", title: "Answering an ask (card, chip, sheet)", machine: askMachine },
  { file: "rooms-request", title: "Rooms request and card busy state", machine: roomsRequestMachine },
  { file: "ota-gate", title: "OTA reload gate", machine: otaGateMachine },
  { file: "composer-shape", title: "Composer shape (pill, card, dictation, hold)", machine: composerShapeMachine },
  { file: "chat-follow", title: "Inverted chat follow", machine: chatFollowMachine },
  { file: "audio-owner", title: "Audio session owner (dictation, legacy call, live call)", machine: audioOwnerMachine },
  { file: "dictation-targets", title: "Dictation target owner stack", machine: targetStackMachine },
  { file: "session", title: "Connection session (discovery, pairing, heartbeat, backoff, background)", machine: sessionMachine },
  { file: "legacy-call", title: "Legacy voice call (host speech over the app socket)", machine: legacyCallMachine },
];

const DOCS = fileURLToPath(new URL("../../../docs/state-machines/", import.meta.url));
const update = process.env["UPDATE_MACHINE_DOCS"] === "1";

describe("docs/state-machines", () => {
  for (const { file, title, machine } of MACHINES) {
    it(`${file}.md matches the ${machine.id} machine`, () => {
      const path = `${DOCS}${file}.md`;
      const diagram = machineDiagram(machine);
      if (!existsSync(path)) {
        if (update) writeFileSync(path, newDoc(title, diagram));
        expect(existsSync(path), `${path} is missing: run pnpm machines:docs`).toBe(true);
      }
      const doc = readFileSync(path, "utf8");
      const next = withDiagram(doc, diagram);
      expect(next, `${path} has no diagram markers`).not.toBeNull();
      if (update && next !== doc && next !== null) writeFileSync(path, next);
      expect(readFileSync(path, "utf8"), `${path} is stale: run pnpm machines:docs`).toBe(next);
      expect(doc.includes("TODO"), `${path} still has a TODO`).toBe(false);
    });
  }
});
