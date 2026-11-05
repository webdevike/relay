// The board's pages (Figma-style), first in the top bar: a quiet button with the current page's
// title opens the page list. A click switches page; on a board this viewer can edit, a
// double-click renames a page in place (Enter saves, Escape cancels), rows drag to reorder, each
// row's menu renames, duplicates or deletes it (after a confirm; never the last page) and "Add
// page" adds one after the current page and goes there. Locked or ended rooms only switch.
import { IconCheck, IconChevronDown, IconCopy, IconDots, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { duplicatePage } from "../../canvas-live/src/board";
import { FIRST_PAGE_TITLE, addPage, deletePage, movePage, newPageId, renamePage } from "../../canvas-live/src/pages";
import { dropIndex, nextPageTitle } from "./boardpages";
import { useCurrentPage, usePages } from "./hooks";
import { doc, setPage } from "./room";

/** Pointer travel (px) before a press on a row becomes a drag. */
const DRAG_PX = 4;

interface Drag {
  id: string;
  from: number;
  startY: number;
  /** Null until the pointer has moved far enough to be a drag. */
  over: { index: number; below: boolean } | null;
}

export function PagePanel({
  editable,
  open,
  setOpen,
}: {
  editable: boolean;
  /** Held by the room: the board (and this panel in its top bar) remounts on every page switch. */
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const pages = usePages();
  const current = useCurrentPage();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** A drag just ended: the click it ends with is not a page switch. */
  const dragged = useRef(false);

  const close = () => {
    setOpen(false);
    setRenaming(null);
    setMenuFor(null);
    setConfirming(null);
  };

  // Outside press or Escape closes it (Escape first backs out of a menu or a confirm).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuFor !== null || confirming !== null) {
        setMenuFor(null);
        setConfirming(null);
      } else close();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, menuFor, confirming]);

  // Leaving edit rights (a lock, the session ending) drops whatever was half done.
  useEffect(() => {
    if (editable) return;
    setRenaming(null);
    setMenuFor(null);
    setConfirming(null);
    setDrag(null);
  }, [editable]);

  // Rows drag with the pointer (mouse, pen or touch): the list shows where the page lands.
  useEffect(() => {
    if (drag === null) return;
    const onMove = (e: PointerEvent) => {
      if (drag.over === null && Math.abs(e.clientY - drag.startY) < DRAG_PX) return;
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-page-row]") ?? [])];
      let over = { index: drag.from, below: false };
      rows.forEach((row, index) => {
        const r = row.getBoundingClientRect();
        if (e.clientY >= r.top) over = { index, below: e.clientY > r.top + r.height / 2 };
      });
      setDrag({ ...drag, over });
    };
    const onUp = () => {
      if (drag.over !== null) {
        dragged.current = true;
        movePage(doc, drag.id, dropIndex(drag.from, drag.over.index, drag.over.below));
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag]);

  // A board this viewer cannot change, with one page, has nothing to show here.
  if (!editable && pages.length < 2) return null;
  const title = pages.find((p) => p.id === current)?.title ?? FIRST_PAGE_TITLE;
  const confirmPage = pages.find((p) => p.id === confirming);

  const add = () => {
    const id = newPageId();
    if (addPage(doc, id, nextPageTitle(pages), current)) setPage(id);
  };
  const duplicate = (id: string, from: string) => {
    const copy = newPageId();
    if (duplicatePage(doc, id, copy, `${from} copy`)) setPage(copy);
  };

  return (
    <div className="cv-pages" ref={rootRef}>
      <button
        type="button"
        className={`cv-toggle cv-pages-btn${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Pages"
        data-testid="canvas-pages"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="cv-pages-title">{title}</span>
        <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <div className={`cv-pages-pop${drag?.over ? " is-dragging" : ""}`} data-testid="canvas-pages-list">
          <div className="cv-pages-list" role="listbox" aria-label="Pages" ref={listRef}>
            {pages.map((p, i) => {
              const here = p.id === current;
              const drop = drag?.over && drag.id !== p.id && drag.over.index === i ? (drag.over.below ? " drop-below" : " drop-above") : "";
              return (
                <div
                  key={p.id}
                  className={`cv-page-row${here ? " is-current" : ""}${drag?.over && drag.id === p.id ? " is-dragged" : ""}${drop}`}
                  data-page-row={p.id}
                >
                  {renaming === p.id ? (
                    <RenameInput
                      title={p.title}
                      onDone={(next) => {
                        if (next !== null && next !== p.title) renamePage(doc, p.id, next);
                        setRenaming(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="cv-page-pick"
                      role="option"
                      aria-selected={here}
                      onPointerDown={(e) => {
                        if (!editable || e.button !== 0) return;
                        dragged.current = false;
                        setDrag({ id: p.id, from: i, startY: e.clientY, over: null });
                      }}
                      onClick={() => {
                        if (dragged.current) {
                          dragged.current = false;
                          return;
                        }
                        setMenuFor(null);
                        setPage(p.id);
                      }}
                      onDoubleClick={() => {
                        if (editable) setRenaming(p.id);
                      }}
                    >
                      <span className="cv-page-check" aria-hidden="true">
                        {here ? <IconCheck size={14} stroke={2} /> : null}
                      </span>
                      <span className="cv-page-name">{p.title}</span>
                    </button>
                  )}
                  {editable && renaming !== p.id ? (
                    <button
                      type="button"
                      className="cv-page-more"
                      aria-label={`Options for ${p.title}`}
                      aria-expanded={menuFor === p.id}
                      title="Options"
                      onClick={() => {
                        setConfirming(null);
                        setMenuFor(menuFor === p.id ? null : p.id);
                      }}
                    >
                      <IconDots size={14} stroke={1.75} />
                    </button>
                  ) : null}
                  {menuFor === p.id ? (
                    <div className="cv-page-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          setRenaming(p.id);
                        }}
                      >
                        <IconPencil size={14} /> Rename
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          duplicate(p.id, p.title);
                        }}
                      >
                        <IconCopy size={14} /> Duplicate
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        disabled={pages.length < 2}
                        title={pages.length < 2 ? "A board keeps at least one page" : undefined}
                        onClick={() => {
                          setMenuFor(null);
                          setConfirming(p.id);
                        }}
                      >
                        <IconTrash size={14} /> Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {confirmPage !== undefined ? (
            <div className="cv-page-confirm" role="alertdialog" aria-label="Delete page">
              <b>Delete {confirmPage.title}?</b>
              <span>Its cards, links and comments go with it.</span>
              <div className="cv-confirm-actions">
                <button
                  type="button"
                  className="cv-toggle cv-danger"
                  onClick={() => {
                    deletePage(doc, confirmPage.id);
                    setConfirming(null);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="cv-toggle"
                  // biome-ignore lint/a11y/noAutofocus: keeping the page is the default, Enter picks it
                  autoFocus
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {editable ? (
            <button type="button" className="cv-page-add" onClick={add}>
              <IconPlus size={14} stroke={1.75} /> Add page
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A page title being renamed: Enter or leaving it saves, Escape cancels (`onDone(null)`). */
function RenameInput({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      className="cv-page-rename"
      aria-label="Page name"
      value={value}
      // biome-ignore lint/a11y/noAutofocus: renaming starts on double-click
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(value);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
