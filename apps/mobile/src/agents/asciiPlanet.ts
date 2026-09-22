/**
 * A ringed planet in ASCII, rendered fresh for any moment `t` (seconds): the globe is a lit
 * sphere whose light swings around it, its cloud bands drift, and the ring's grain slides along
 * the ellipse. Pure, so the same `t` always gives the same frame; every frame is the same size.
 */

export const PLANET_COLS = 30;
export const PLANET_ROWS = 12;
/** Darkest to brightest: a bright figure on a dark screen. */
const RAMP = " .,:;-=+*#%@";
/** The ring's grain, scrolled along its length. */
const GRAIN = "-=~=--=~~=-";
/** A terminal cell is about twice as tall as it is wide; the globe is squashed to stay round. */
const CELL_ASPECT = 2;
const CX = PLANET_COLS / 2;
const CY = PLANET_ROWS / 2 - 0.5;
/** Globe radius in rows. */
const R = 4;
/** Ring semi-axes: long across the columns, thin across the rows, tilted a touch. */
const RING_A = 14;
const RING_B = 2.4;
const TILT = 0;

export function asciiPlanet(t: number): string[] {
  // The light swings round once every ~9 s; the bands drift the other way, slower.
  const lightAngle = t * 0.7;
  const lx = Math.cos(lightAngle);
  const ly = -0.35;
  const lz = Math.sin(lightAngle) * 0.8 + 0.35;
  const ll = Math.hypot(lx, ly, lz);
  const rows: string[] = [];
  for (let y = 0; y < PLANET_ROWS; y += 1) {
    let line = "";
    for (let x = 0; x < PLANET_COLS; x += 1) {
      line += cellAt(x, y, t, lx / ll, ly / ll, lz / ll);
    }
    rows.push(line);
  }
  return rows;
}

function cellAt(x: number, y: number, t: number, lx: number, ly: number, lz: number): string {
  const dx = (x - CX) / CELL_ASPECT;
  const dy = y - CY;
  const globe = dx * dx + dy * dy <= R * R;
  const ring = ringAt(dx, dy, t);
  // The near half of the ring passes in front of the globe, the far half behind it.
  if (ring !== null && (ring.front || !globe)) return ring.glyph;
  if (!globe) return " ";
  const nx = dx / R;
  const ny = dy / R;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  let shade = Math.max(0, nx * lx + ny * ly + nz * lz);
  // Cloud bands: a slow sine across latitude, drifting with time, brightening some belts and dimming others.
  shade *= 0.8 + 0.2 * Math.sin(ny * 7 + t * 0.4);
  // Limb darkening keeps the edge soft against the black.
  shade *= 0.55 + 0.45 * nz;
  const level = Math.min(RAMP.length - 1, Math.floor(shade * (RAMP.length - 1) + 0.999));
  return RAMP[Math.max(1, level)] ?? " ";
}

/** The ring is the ellipse's edge, tilted: the cell is ring when it sits within half a row of it. */
function ringAt(dx: number, dy: number, t: number): { glyph: string; front: boolean } | null {
  // Undo the tilt so the ellipse is axis-aligned; work in rows for both axes.
  const px = dx;
  const py = dy;
  const ux = px * Math.cos(TILT) + py * Math.sin(TILT);
  const uy = -px * Math.sin(TILT) + py * Math.cos(TILT);
  const a = RING_A / CELL_ASPECT;
  const inside = 1 - (ux * ux) / (a * a);
  if (inside < 0) return null;
  const edge = RING_B * Math.sqrt(inside);
  // Where the ellipse turns steeply (its ends) one column spans several rows; widen the hit so
  // the line stays unbroken there.
  const step = 1 / CELL_ASPECT;
  const ahead = 1 - ((ux + step) * (ux + step)) / (a * a);
  const slope = ahead < 0 ? RING_B : Math.abs(RING_B * Math.sqrt(ahead) - edge);
  const reach = 0.5 + slope / 2;
  const near = Math.abs(uy - edge) <= reach;
  const far = Math.abs(uy + edge) <= reach;
  if (!near && !far) return null;
  const angle = Math.atan2(near ? edge : -edge, ux);
  // The grain slides around the ring; the lower half (screen y down) is the near side.
  const along = (((Math.floor((angle / (2 * Math.PI)) * 48 + t * 4) % GRAIN.length) + GRAIN.length) % GRAIN.length);
  const glyph = GRAIN[along] ?? "-";
  if (glyph === " ") return null;
  return { glyph, front: near };
}
