// A one-line comment field with an `@` menu: typing `@` (or `@as`) lists the agents a comment can be
// for (the registry's assistants and whoever joined the room, from `meta.mentionables`); Tab or
// Enter picks one, Arrow keys move, Escape closes the menu (and only the menu). The host reads the
// `@name` in the sent text to route the thread, so the menu only helps spell it.
import { IconAt } from "@tabler/icons-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { activeMention, insertMention, suggest, type Mentionable } from "../../canvas-live/src/mentions";
import { Face } from "./avatar";

const FALLBACK_COLOR = "#8b5cf6";

export function MentionInput({
  value,
  onChange,
  onEnter,
  onEscape,
  candidates,
  className,
  ...rest
}: {
  value: string;
  onChange: (text: string) => void;
  /** Enter with no menu open. */
  onEnter: () => void;
  onEscape: () => void;
  candidates: readonly Mentionable[];
  className?: string;
  "aria-label": string;
  placeholder: string;
  enterKeyHint?: "send";
  onBlur?: () => void;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const field = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = activeMention(value, Math.min(caret, value.length));
  const options = active === null ? [] : suggest(active.query, candidates);
  const open = active !== null && options.length > 0 && dismissed !== `${String(active.start)}:${active.query}`;
  useEffect(() => setPicked(0), [active?.query]);

  const choose = (candidate: Mentionable): void => {
    if (active === null) return;
    const next = insertMention(value, active, candidate);
    onChange(next.text);
    setCaret(next.caret);
    // The caret moves after the new value is in the field.
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };

  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const candidate = options[picked];
        if (candidate !== undefined) choose(candidate);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (active !== null) setDismissed(`${String(active.start)}:${active.query}`);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Escape") onEscape();
  };

  return (
    <div className="cv-mention">
      {open ? (
        <ul className="cv-mention-menu" role="listbox" aria-label="Agents" data-testid="canvas-mention-menu">
          {options.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === picked}>
              <button
                type="button"
                className={`cv-mention-item${i === picked ? " is-picked" : ""}`}
                data-testid="canvas-mention-option"
                data-agent={c.id}
                // Keep the field focused: a click on the menu must not blur it.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
              >
                {c.avatar !== undefined || c.color !== undefined ? <Face who={{ name: c.name, color: c.color ?? FALLBACK_COLOR, kind: "agent", avatar: c.avatar }} size={20} /> : <IconAt size={16} stroke={1.75} aria-hidden="true" />}
                <span className="cv-mention-name">{c.name}</span>
                <span className="cv-mention-hint">{c.joined === true ? "in the room" : (c.hint ?? "")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={(el) => {
          field.current = el;
          rest.inputRef?.(el);
        }}
        className={className}
        aria-label={rest["aria-label"]}
        aria-autocomplete="list"
        aria-expanded={open}
        placeholder={rest.placeholder}
        enterKeyHint={rest.enterKeyHint}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          onChange(e.target.value);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onKeyDown={keys}
        onBlur={rest.onBlur}
      />
    </div>
  );
}
