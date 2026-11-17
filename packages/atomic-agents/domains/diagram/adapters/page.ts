/**
 * What runs inside the render page (`Renderer.ts` hands these to Playwright's `page.evaluate`): each function is
 * serialized on its own, so it may use only its argument and the DOM, nothing from this module.
 */

export interface Limits {
  /** Smallest font size, in viewBox units (14px in the 2x PNG). */
  readonly minFont: number;
  /** WCAG contrast ratio text must reach on what is painted under it. */
  readonly minContrast: number;
  /** Text fainter than this (a watermark numeral) is decoration: not measured. */
  readonly decorativeAlpha: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly minTexts: number;
  /** Share of the smaller of two text boxes the other may cover. */
  readonly overlap: number;
  /** Pixels past an edge before text counts as cut off or spilling. */
  readonly slack: number;
}

export interface Found {
  /** Fatal: no usable image (nothing to repair from but the source). Else a legibility defect. */
  readonly fatal: boolean;
  readonly message: string;
}

export type Mounted =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly problems: ReadonlyArray<Found> };

/** Parse the SVG as XML (what a standalone .svg file is), check its frame, and put it in the page at its viewBox size. */
export const mount = ({
  svg,
  limits,
}: {
  readonly svg: string;
  readonly limits: Limits;
}): Mounted => {
  const fatal = (message: string): Mounted => ({ ok: false, problems: [{ fatal: true, message }] });
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const error = parsed.querySelector("parsererror");
  if (error !== null)
    return fatal(
      `the SVG is not well-formed XML: ${(error.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 300)}`,
    );
  const root = parsed.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
    return fatal('the root element must be <svg xmlns="http://www.w3.org/2000/svg">');
  }
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    box.length !== 4 ||
    box.some((value) => !Number.isFinite(value)) ||
    box[2]! <= 0 ||
    box[3]! <= 0
  )
    return fatal("the <svg> needs a viewBox: 0 0 <width> <height>");
  const width = box[2]!;
  const height = box[3]!;
  if (
    width < limits.minWidth ||
    width > limits.maxWidth ||
    height < limits.minHeight ||
    height > limits.maxHeight
  ) {
    return fatal(
      `the viewBox is ${width} x ${height}; keep it within ${limits.minWidth} to ${limits.maxWidth} wide and ${limits.minHeight} to ${limits.maxHeight} tall`,
    );
  }
  const node = document.importNode(root, true);
  node.setAttribute("width", String(width));
  node.setAttribute("height", String(height));
  document.body.appendChild(node);
  return { ok: true, width, height };
};

/** Measure the mounted SVG as rendered (fonts loaded): references, accessible title, and every text's size, edges, overlaps, box fit and contrast. */
export const measure = ({
  limits,
  paper,
}: {
  readonly limits: Limits;
  readonly paper: string;
}): ReadonlyArray<Found> => {
  const svg = document.querySelector("body > svg") as SVGSVGElement;
  const found: Array<Found> = [];
  const say = (message: string) => found.push({ fatal: false, message });
  const view = svg.viewBox.baseVal;
  const frame = svg.getBoundingClientRect();
  const k = view.width / frame.width;
  const quote = (element: Element) =>
    `"${(element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 48)}"`;

  const canvas = document.createElement("canvas").getContext("2d")!;
  /** Any CSS color as [r, g, b, a]; none, url() and unparsable as undefined. */
  const rgba = (value: string): [number, number, number, number] | undefined => {
    if (value === "" || value === "none" || value.startsWith("url(")) return undefined;
    canvas.fillStyle = "#010203";
    canvas.fillStyle = value;
    const parsed = String(canvas.fillStyle);
    if (parsed === "#010203" && value.replace(/\s/g, "").toLowerCase() !== "#010203")
      return undefined;
    if (parsed.startsWith("#"))
      return [
        parseInt(parsed.slice(1, 3), 16),
        parseInt(parsed.slice(3, 5), 16),
        parseInt(parsed.slice(5, 7), 16),
        1,
      ];
    const parts = (/\(([^)]+)\)/.exec(parsed)?.[1] ?? "").split(",").map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  };
  /** An element's fill as painted: fill alpha x fill-opacity x every opacity up to the svg. */
  const paint = (element: Element) => {
    const style = getComputedStyle(element);
    const color = rgba(style.fill);
    if (color === undefined || style.visibility === "hidden") return undefined;
    let alpha = color[3] * Number(style.fillOpacity || "1");
    for (
      let node: Element | null = element;
      node !== null && node !== svg.parentElement;
      node = node.parentElement
    )
      alpha *= Number(getComputedStyle(node).opacity || "1");
    return [color[0], color[1], color[2], alpha] as const;
  };
  const luminance = (color: ReadonlyArray<number>) => {
    const [r, g, b] = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const SHAPES = ["rect", "circle", "ellipse", "path", "polygon"];
  /** The filled shapes under a viewport point, topmost first. */
  const shapesAt = (x: number, y: number) =>
    document
      .elementsFromPoint(x, y)
      .filter(
        (element) =>
          svg.contains(element) &&
          SHAPES.includes(element.localName) &&
          (paint(element)?.[3] ?? 0) > 0,
      );
  /** What is painted at a point: the shapes there composited front to back over the page paper. */
  const backdrop = (shapes: ReadonlyArray<Element>) => {
    const sum = [0, 0, 0];
    let covered = 0;
    for (const shape of shapes) {
      const color = paint(shape)!;
      const share = (1 - covered) * color[3];
      for (let channel = 0; channel < 3; channel++) sum[channel]! += share * color[channel]!;
      covered += share;
      if (covered >= 0.995) break;
    }
    const base = rgba(paper)!;
    return sum.map((value, channel) => value + (1 - covered) * base[channel]!);
  };

  const first = svg.firstElementChild;
  if (first === null || first.localName !== "title" || (first.textContent ?? "").trim() === "")
    say("the first child of <svg> must be a non-empty <title>");
  const description = svg.querySelector(":scope > desc");
  if (description === null || (description.textContent ?? "").trim() === "")
    say("the <svg> needs a non-empty <desc> (one sentence about the content) after the <title>");
  if (shapesAt(frame.left + 1, frame.top + 1).length === 0)
    say("nothing paints the canvas corner: draw the paper rect over the whole viewBox first");

  const missing = new Set<string>();
  for (const element of svg.querySelectorAll("*")) {
    for (const attribute of [
      "marker-start",
      "marker-mid",
      "marker-end",
      "fill",
      "stroke",
      "filter",
      "clip-path",
      "mask",
    ]) {
      const id = /url\(\s*['"]?#([^'")\s]+)/.exec(element.getAttribute(attribute) ?? "")?.[1];
      if (id !== undefined && document.getElementById(id) === null) missing.add(id);
    }
  }
  for (const id of missing)
    say(`url(#${id}) points to nothing: define #${id} in <defs> or drop the reference`);

  const texts = [...svg.querySelectorAll("text")].filter(
    (text) => (text.textContent ?? "").trim() !== "",
  );
  if (texts.length < limits.minTexts)
    found.push({
      fatal: true,
      message: `the diagram has ${texts.length} text labels; it needs at least ${limits.minTexts}`,
    });

  const measured: Array<{ readonly text: SVGTextElement; readonly box: DOMRect }> = [];
  for (const text of texts) {
    const box = text.getBoundingClientRect();
    const color = paint(text);
    if (
      box.width === 0 ||
      box.height === 0 ||
      color === undefined ||
      color[3] < limits.decorativeAlpha
    )
      continue;
    measured.push({ text, box });

    const matrix = text.getCTM();
    const scale =
      matrix === null ? 1 : Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
    const size = Math.min(
      ...[text, ...text.querySelectorAll("tspan")].map(
        (element) => Number.parseFloat(getComputedStyle(element).fontSize) * scale * k,
      ),
    );
    if (size < limits.minFont - 0.01)
      say(
        `text ${quote(text)} is ${Math.round(size * 10) / 10}px; nothing under ${limits.minFont}px`,
      );

    const past =
      Math.max(
        frame.left - box.left,
        box.right - frame.right,
        frame.top - box.top,
        box.bottom - frame.bottom,
      ) * k;
    if (past > limits.slack)
      say(`text ${quote(text)} runs ${Math.ceil(past)}px past the canvas edge`);

    const under = shapesAt((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    const behind = backdrop(under);
    const front = [0, 1, 2].map(
      (channel) => color[3] * color[channel]! + (1 - color[3]) * behind[channel]!,
    );
    const [light, dark] = [luminance(front), luminance(behind)].sort((a, b) => b - a);
    const ratio = (light! + 0.05) / (dark! + 0.05);
    if (ratio < limits.minContrast)
      say(
        `text ${quote(text)} has contrast ${ratio.toFixed(1)}:1 on what is under it; it needs ${limits.minContrast}:1`,
      );

    // The rects the text sits on, sampled at its two ends and its middle: a text wider than its box shows past it.
    const middle = (box.top + box.bottom) / 2;
    const holders = new Set(
      [box.left + 1, box.right - 1].map((x) => shapesAt(x, middle)[0]).concat(under[0]),
    );
    for (const holder of holders) {
      if (holder === undefined || holder.localName !== "rect") continue;
      const area = holder.getBoundingClientRect();
      if (area.width >= frame.width * 0.9) continue;
      const spill = Math.max(area.left - box.left, box.right - area.right) * k;
      if (spill > limits.slack) {
        say(
          `text ${quote(text)} spills ${Math.ceil(spill)}px out of the box it sits in: widen the box or shorten the text`,
        );
        break;
      }
    }
  }

  for (let i = 0; i < measured.length; i++) {
    for (let j = i + 1; j < measured.length; j++) {
      const a = measured[i]!.box;
      const b = measured[j]!.box;
      const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (across <= 0 || down <= 0) continue;
      if (across * down > limits.overlap * Math.min(a.width * a.height, b.width * b.height)) {
        say(`texts ${quote(measured[i]!.text)} and ${quote(measured[j]!.text)} overlap`);
      }
    }
  }
  return found;
};

/** Share of a PNG's pixels (as a data URL) that differ from its top-left pixel: near zero is a blank render. */
export const inkShare = async (url: string): Promise<number> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const width = 400;
  const height = Math.max(1, Math.round((width * image.height) / image.width));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  let inked = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (
      Math.abs(data[index]! - data[0]!) +
        Math.abs(data[index + 1]! - data[1]!) +
        Math.abs(data[index + 2]! - data[2]!) >
      48
    )
      inked++;
  }
  return inked / (width * height);
};
