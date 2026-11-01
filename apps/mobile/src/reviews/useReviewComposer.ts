/**
 * The composer of one item's screen: its draft, whether the typing card is open, the post waiting
 * on the confirm sheet, an image uploading into a Linear draft and the item's Astra session.
 * Opening the screen asks the host for an existing session; sending an `@Astra` text asks her at
 * once, anything else opens the confirm sheet, whose confirm alone sends.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";
import type { AstraItem, ReviewRef, ReviewsOp } from "@relay/protocol";
import { reviewsRequest, sendCommand } from "@/connection";
import { choosePhoto } from "@/lib/photo";
import { useReviewsStore } from "@/state/reviews";
import type { ConfirmPost } from "./ConfirmSheet";
import { composerIntent, withPendingAsk, type ComposerTarget } from "./model";

export interface PendingPost extends ConfirmPost {
  op: ReviewsOp;
}

export interface ReviewComposer {
  draft: string;
  setDraft: (text: string) => void;
  /** The typing card shows instead of the action bars. */
  open: boolean;
  /** Opens the card (the keyboard comes up with it); `prefill` goes in front of the draft unless it is already there. */
  compose: (prefill?: string) => void;
  /** The keyboard went down: an empty draft folds back into the bars, a written one keeps the card. */
  collapse: () => void;
  /** The confirm sheet's post, while it shows. */
  pending: PendingPost | null;
  posting: boolean;
  postError: string | null;
  /** The item's Astra session as the timeline shows it: an ask it does not show yet at the end, a failed ask as its error. */
  astra: AstraItem | undefined;
  send: () => void;
  /** Opens the confirm sheet for any post (the PR menu's Approve and Request changes too). */
  confirm: (post: PendingPost) => void;
  post: () => void;
  cancel: () => void;
  /** "Use as reply": that answer becomes the draft and the card opens. */
  takeAnswer: (text: string) => void;
  stop: () => void;
  /** Changes whenever Astra's part of the timeline grows or changes state (followed while at the bottom). */
  followKey: string;
  /** Changes when Isaac asks Astra (the timeline scrolls to his ask). */
  revealKey: number;
  /** Linear only: picks a photo, uploads it to Linear and adds it to the draft; null where images cannot go. */
  attachImage: (() => void) | null;
  uploading: boolean;
}

export function useReviewComposer(
  url: string,
  reference: ReviewRef | null,
  target: ComposerTarget | null,
  onPosted: (message: string) => void,
  notify: (message: string) => void,
): ReviewComposer {
  const session = useReviewsStore((state) => state.astra[url]);
  const asked = useReviewsStore((state) => state.asks[url]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingPost | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // The photo picker takes the keyboard down; the card stays open through the pick and the upload.
  const attaching = useRef(false);

  useEffect(() => {
    void reviewsRequest({ kind: "astra", url });
  }, [url]);

  const shown = withPendingAsk(session, url, asked);
  const astra: AstraItem | undefined =
    askError === null ? shown : { ...(shown ?? { url, title: "Astra", sessionId: null, turns: [], working: false, waiting: null }), error: askError };

  const confirm = useCallback((post: PendingPost) => {
    // The sheet rises from the bottom: with the keyboard up it would open behind it.
    Keyboard.dismiss();
    setPostError(null);
    setPending(post);
  }, []);

  const send = () => {
    if (target === null || reference === null || uploading) return;
    const intent = composerIntent(draft, target);
    if (intent === null) return;
    if (intent.kind === "post") {
      confirm({ op: intent.op, destination: intent.destination, text: intent.op.kind === "slackSend" ? intent.op.text : draft.trim(), action: intent.action });
      return;
    }
    setDraft("");
    if (!Keyboard.isVisible()) setOpen(false);
    setAskError(null);
    // Isaac's card and Astra's working state show now; the session's own turn replaces them.
    useReviewsStore.getState().ask(url, intent.text);
    void reviewsRequest({ kind: "astraAsk", url, ref: reference, text: intent.text }).then((result) => {
      if (result.ok) return;
      useReviewsStore.getState().dropAsk(url);
      setAskError(result.error ?? "Astra could not take that.");
    });
  };

  const post = () => {
    if (pending === null) return;
    setPosting(true);
    setPostError(null);
    void reviewsRequest(pending.op).then((result) => {
      setPosting(false);
      if (!result.ok) {
        setPostError(result.error ?? "It did not go through.");
        return;
      }
      setDraft("");
      setOpen(false);
      setPending(null);
      onPosted(pending.op.kind === "slackSend" ? "Handed to Astra to send" : "Posted");
    });
  };

  const attachImage = async () => {
    attaching.current = true;
    const photo = await choosePhoto("library").catch((error: unknown) => {
      notify(error instanceof Error ? error.message : "Could not open your photos.");
      return null;
    });
    if (photo === null) {
      attaching.current = false;
      return;
    }
    const name = `image-${String(Date.now())}.jpg`;
    setUploading(true);
    const result = await reviewsRequest({ kind: "linearUpload", name, mime: "image/jpeg", data: photo.image.data });
    setUploading(false);
    attaching.current = false;
    if (!result.ok || result.url === undefined) {
      notify(result.error ?? "The image did not upload.");
      return;
    }
    const image = `![${name}](${result.url})`;
    setDraft((text) => (text.trim() === "" ? `${image}\n` : `${text.replace(/\s*$/, "")}\n\n${image}\n`));
    setOpen(true);
  };

  const turns = astra?.turns ?? [];
  const newest = turns[turns.length - 1];
  return {
    draft,
    setDraft,
    open,
    compose: (prefill) => {
      if (prefill !== undefined && !draft.startsWith(prefill)) setDraft(`${prefill}${draft}`);
      setOpen(true);
    },
    collapse: () => {
      if (draft.trim() === "" && !attaching.current) setOpen(false);
    },
    pending,
    posting,
    postError,
    astra,
    send,
    confirm,
    post,
    cancel: () => {
      setPending(null);
      setPostError(null);
    },
    takeAnswer: (text) => {
      setDraft(text);
      setOpen(true);
    },
    stop: () => {
      const sessionId = astra?.sessionId ?? null;
      if (sessionId !== null) void sendCommand({ kind: "agent.abort", sessionId }).catch(() => undefined);
    },
    followKey: `${String(turns.length)}:${String(newest?.text.length ?? 0)}:${String(astra?.working ?? false)}:${astra?.waiting ?? ""}:${astra?.error ?? ""}`,
    revealKey: asked?.at ?? 0,
    attachImage:
      target?.kind === "linear"
        ? () => {
            void attachImage();
          }
        : null,
    uploading,
  };
}
