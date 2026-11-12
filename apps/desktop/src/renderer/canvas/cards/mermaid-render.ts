/** The pure parts of drawing an explainer's Mermaid diagram. */

/** Mermaid's theme for the app's color scheme. */
export function mermaidTheme(scheme: string): 'dark' | 'default' {
  return scheme === 'dark' ? 'dark' : 'default'
}

let counter = 0

/** A DOM-safe id no earlier render used (mermaid.render makes an element with it). */
export function nextMermaidId(): string {
  counter += 1
  return `eva-cv-mermaid-${counter}`
}
