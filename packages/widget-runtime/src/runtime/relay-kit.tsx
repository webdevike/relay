/**
 * The `relay` design system's components: Relay Desktop's own presentational components, imported
 * from apps/desktop's renderer as they are (build.ts bundles them with this package's one React and
 * Mantine), so a prototype draws the app's real rows, chips and menus. Their CSS and tokens come
 * from the same app files (generated/relay/styles.ts, ../systems/css.ts).
 */
import type { CSSProperties } from "react";
import { AssistantAvatar } from "../../../../apps/desktop/src/renderer/assistants/AssistantAvatar";
import { AssistantCard } from "../../../../apps/desktop/src/renderer/assistants/AssistantCard";
import { stepIcon } from "../../../../apps/desktop/src/renderer/canvas/cards/step-icons";
import {
  ChipStrip,
  SessionChip,
  SpecialistChip,
} from "../../../../apps/desktop/src/renderer/chat/strips/Chip";
import { RelayMenu } from "../../../../apps/desktop/src/renderer/overlay/RelayMenu";
import { ListLayoutProvider } from "../../../../apps/desktop/src/renderer/ui/list/list-context";
import {
  ListEmpty,
  ListKpis,
  ListMarks,
  ListPill,
  ListStatus,
  ListTime,
} from "../../../../apps/desktop/src/renderer/ui/list/ListParts";
import { ListRow } from "../../../../apps/desktop/src/renderer/ui/list/ListRow";

export interface TablerIconProps {
  /** Kebab-case Tabler name, e.g. `list-check`. */
  name: string;
  size?: number | string;
  stroke?: number | string;
  color?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A Tabler icon by kebab-case name (`list-check`, also `IconListCheck`) from the set canvas step
 * cards draw (canvas/cards/step-icons.ts); an unknown name draws a plain circle.
 */
function TablerIcon({ name, size = 16, stroke = 1.5, ...rest }: TablerIconProps) {
  const Icon = stepIcon(name);
  return <Icon size={size} stroke={stroke} aria-hidden {...rest} />;
}

/** Every name the kit adds to a `relay` prototype's scope. */
export const RELAY_KIT: Record<string, unknown> = {
  ListRow,
  ListPill,
  ListStatus,
  ListMarks,
  ListTime,
  ListKpis,
  ListEmpty,
  ListLayoutProvider,
  SpecialistChip,
  SessionChip,
  ChipStrip,
  AssistantAvatar,
  AssistantCard,
  RelayMenu,
  TablerIcon,
};
