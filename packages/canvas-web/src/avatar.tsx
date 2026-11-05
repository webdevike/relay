// One face for a person everywhere on the page (room bar, side panel, cursors, pins, thread
// replies): their avatar when they have one, the room agent's own avatar for the room agent (its
// assistant's DiceBear portrait from the registry, the drawing Relay desktop's chat header uses),
// else their initial on their color.
import { type CSSProperties, createContext, useContext } from "react";
import { avatarFor } from "./comments";
import { avatarUrl } from "./env";
import { env } from "./room";

/** The room agent's name and avatar, provided once at the top of the page. */
export const RoomAgentContext = createContext<{ name: string; avatar: string | undefined } | null>(null);

export function Face({
  who,
  size = 20,
  className,
  ring = false,
}: {
  who: { name: string; color: string; kind?: "human" | "agent"; avatar?: string | undefined };
  size?: number;
  className?: string;
  /** Outline the face in the person's color (who is who at a glance in the room's lists). */
  ring?: boolean;
}) {
  const src = avatarFor(who, useContext(RoomAgentContext));
  const style: CSSProperties = { width: size, height: size, ...(ring ? { borderColor: who.color } : {}) };
  const cls = `cv-face${ring ? " is-ring" : ""}${className ? ` ${className}` : ""}`;
  if (src !== undefined)
    return <img className={cls} src={avatarUrl(env, src)} alt="" style={style} data-avatar={src} />;
  return (
    <i
      className={`${cls} is-initial`}
      style={{ ...style, background: who.color, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      {who.name.slice(0, 1).toUpperCase()}
    </i>
  );
}
