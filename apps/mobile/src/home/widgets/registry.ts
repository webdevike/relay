/** Every Home widget kind: its name (in the gallery and VoiceOver), gallery blurb, glyph and body. */
import type { ComponentType } from "react";
import type { SFSymbol } from "expo-symbols";
import type { WidgetKind, WidgetSize } from "./layout";
import type { WidgetBodyProps, WidgetColor } from "./WidgetParts";
import { UsageWidget } from "./kinds/UsageWidget";
import { AssistantsWidget } from "./kinds/AssistantsWidget";
import { InboxWidget } from "./kinds/InboxWidget";
import { BoardsWidget } from "./kinds/BoardsWidget";
import { AppsWidget } from "./kinds/AppsWidget";

export interface WidgetKindSpec {
  title: string;
  description: string;
  symbol: SFSymbol;
  color: WidgetColor;
  Body: ComponentType<WidgetBodyProps>;
}

export const WIDGET_REGISTRY: Record<WidgetKind, WidgetKindSpec> = {
  usage: {
    title: "Usage",
    description: "Plan limits of your Claude and Codex accounts.",
    symbol: "gauge.with.dots.needle.67percent",
    color: "pink",
    Body: UsageWidget,
  },
  assistants: {
    title: "Assistants",
    description: "What your assistants said last.",
    symbol: "bubble.left.and.text.bubble.right.fill",
    color: "blue",
    Body: AssistantsWidget,
  },
  inbox: {
    title: "Inbox",
    description: "Sessions waiting on you.",
    symbol: "tray.fill",
    color: "orange",
    Body: InboxWidget,
  },
  boards: {
    title: "Boards",
    description: "Live dashboards from the host.",
    symbol: "chart.xyaxis.line",
    color: "green",
    Body: BoardsWidget,
  },
  apps: {
    title: "Apps",
    description: "Assistants, Inbox, Usage, Live view, Trackpad, Boards and Settings.",
    symbol: "square.grid.2x2.fill",
    color: "gray",
    Body: AppsWidget,
  },
};

export const SIZE_LABEL: Record<WidgetSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};
