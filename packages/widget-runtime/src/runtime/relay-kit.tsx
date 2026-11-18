/**
 * The `relay` design system's components: Relay Desktop's own presentational components, imported
 * from apps/desktop's renderer as they are (build.ts bundles them with this package's one React and
 * Mantine), so a prototype draws the app's real rows, chips and menus. Their CSS and tokens come
 * from the same app files (generated/relay/styles.ts, ../systems/css.ts).
 */
import type { CSSProperties } from "react";
import {
  AssistantAvatar as AppAssistantAvatar,
  type AssistantAvatarProps,
} from "../../../../apps/desktop/src/renderer/assistants/AssistantAvatar";
import {
  AssistantCard as AppAssistantCard,
  type AssistantCardProps,
} from "../../../../apps/desktop/src/renderer/assistants/AssistantCard";
import { stepIcon } from "../../../../apps/desktop/src/renderer/canvas/cards/step-icons";
import { ChipStrip, SessionChip } from "../../../../apps/desktop/src/renderer/chat/strips/Chip";
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

/** One registry assistant as a page knows it: its name and its designed portrait. */
export interface KitAssistant {
  title: string;
  avatar: AssistantCardProps["face"];
}

/**
 * The assistant registry (Eva's .omp/assistant/agents.json) as Relay Desktop read it, handed to
 * the page when it boots (proto.ts `assistants`), so `agent="nova"` draws Nova's real portrait.
 */
let registry: Readonly<Record<string, KitAssistant>> = {};

export function setKitAssistants(assistants: Readonly<Record<string, KitAssistant>>): void {
  registry = assistants;
}

/**
 * Registry assistant `agent`. A page with no registry (a phone or a live room) falls back to a
 * face seeded by the id; an id the registry lacks is an error that names the ones it has.
 */
function assistantOf(agent: string): KitAssistant {
  const known = registry[agent];
  if (known) return known;
  const ids = Object.keys(registry);
  if (ids.length > 0)
    throw new Error(`No assistant "${agent}"; the registry has ${ids.join(", ")}`);
  return { title: agent, avatar: agent };
}

/** A portrait to draw: a registry assistant's (`agent`), or a seed or designed one (`face`). */
type FaceOrAgent =
  { agent: string; face?: undefined } | { agent?: undefined; face: AssistantCardProps["face"] };

/** The app's AssistantAvatar; `agent="nova"` draws that registry assistant's real portrait. */
function AssistantAvatar(props: Omit<AssistantAvatarProps, "face"> & FaceOrAgent) {
  const { agent, face, ...rest } = props;
  return (
    <AppAssistantAvatar {...rest} face={agent === undefined ? face : assistantOf(agent).avatar} />
  );
}

/**
 * The Assistants page's cover card; `agent="nova"` takes that registry assistant's real portrait
 * and, unless `title` is given, its name.
 */
function AssistantCard(
  props: Omit<AssistantCardProps, "face" | "title"> & FaceOrAgent & { title?: string },
) {
  const { agent, face, title, ...rest } = props;
  if (agent === undefined) return <AppAssistantCard {...rest} title={title ?? ""} face={face} />;
  const known = assistantOf(agent);
  return <AppAssistantCard {...rest} title={title ?? known.title} face={known.avatar} />;
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
  SessionChip,
  ChipStrip,
  AssistantAvatar,
  AssistantCard,
  RelayMenu,
  TablerIcon,
};
