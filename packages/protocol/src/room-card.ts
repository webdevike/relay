// The room card: an assistant that set up a room (agent action rooms.create, `relay-linux rooms
// create`) puts the token it got back, `[[room:<roomId>]]` or `[[room:<roomId> | <title>]]`, on its
// own line in its reply. Relay desktop draws a live card of that room in its place (Room ready, or a
// council proposal); the phone a compact card that opens the room, or `Room: <title>` when the room
// is not on its wire; the host leaves it out of pushes and speech. One parser for every client.

/** A room a reply points at: its id, and the title it had when the token was made. */
export interface RoomCardRef {
  id: string;
  title?: string;
}

const TOKEN = /\[\[room:\s*([a-z0-9][a-z0-9._-]{0,63})\s*(?:\|\s*([^\]\n]*?)\s*)?\]\]/g;
const OPENER = "[[room:";
const FENCE = /^[ \t]*(?:```|~~~)/;
const MAX_CARDS = 4;

/**
 * Cuts every room token out of a reply (outside code fences) and returns the rooms in order, each
 * once. A line left empty by its token goes, and a blank run it leaves collapses. While the reply
 * is `streaming`, a token that has only partly arrived at its end is cut too.
 */
export function splitRoomCards(text: string, streaming = false): { text: string; rooms: RoomCardRef[] } {
  if (!text.includes("[")) return { text, rooms: [] };
  const rooms: RoomCardRef[] = [];
  const kept: string[] = [];
  let fenced = false;
  let cut = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || !line.includes(OPENER)) {
      kept.push(line);
      continue;
    }
    const rest = line.replace(TOKEN, (_all, id: string, title: string | undefined) => {
      if (!rooms.some((r) => r.id === id) && rooms.length < MAX_CARDS) rooms.push(title ? { id, title } : { id });
      cut = true;
      return "";
    });
    if (rest === line) kept.push(line);
    else if (rest.trim() !== "") kept.push(rest.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ").trimEnd());
  }
  let out = cut ? kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "") : text;
  if (streaming && !fenced) {
    const start = out.lastIndexOf("[[");
    const tail = start < 0 ? (out.endsWith("[") ? "[" : "") : out.slice(start);
    if (tail !== "" && !tail.includes("]]") && (OPENER.startsWith(tail) || tail.startsWith(OPENER)))
      out = out.slice(0, out.length - tail.length).trimEnd();
  }
  return { text: out, rooms };
}

/** What a reply shows where a room's card cannot be drawn: `Room: <title>`. */
export const roomCardFallback = (ref: RoomCardRef): string => (ref.title ? `Room: ${ref.title}` : "Room");
