/**
 * One tool call in the transcript: a small glyph for the tool, the one-line summary of what it
 * did (omp's intent string when the tool has one), and the tool's name trailing faintly. Reads
 * as a quiet log line between the agent's paragraphs, not a message of its own.
 */
import { View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { colors, spacing } from "@/theme";
import { Text } from "@/ui/Text";

const GLYPH = 14;

const glyphFor: Record<string, SFSymbol> = {
  read: "doc.text",
  write: "square.and.pencil",
  edit: "pencil.line",
  bash: "terminal",
  grep: "magnifyingglass",
  glob: "folder",
  eval: "chevron.left.forwardslash.chevron.right",
  task: "person.2",
  hub: "antenna.radiowaves.left.and.right",
  todo: "checklist",
  ask: "questionmark.circle",
  web_search: "globe",
  lsp: "curlybraces",
  debug: "ladybug",
  ast_edit: "point.3.connected.trianglepath.dotted",
};
const DEFAULT_GLYPH: SFSymbol = "wrench.and.screwdriver";

/** MCP tools arrive as `server__tool`; the tool's own name is what reads. */
function displayName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

export interface ToolRowProps {
  name: string;
  summary: string;
}

export function ToolRow({ name, summary }: ToolRowProps) {
  const label = displayName(name);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
      }}
    >
      <SymbolView
        name={glyphFor[label] ?? DEFAULT_GLYPH}
        size={GLYPH}
        tintColor={colors.textFaint}
        weight="medium"
      />
      <Text variant="caption" color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }}>
        {summary.length > 0 ? summary : label}
      </Text>
      {summary.length > 0 && (
        <Text variant="caption" color="textFaint" numberOfLines={1}>
          {label}
        </Text>
      )}
    </View>
  );
}
