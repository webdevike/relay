/** A tool's name as it reads: MCP tools arrive as `server__tool`, and the tool's own name is what reads. */
export function toolLabel(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}
