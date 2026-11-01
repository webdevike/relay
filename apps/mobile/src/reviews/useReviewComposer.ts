/**
 * The composer of one item's screen: its draft, the post waiting on the confirm sheet and the
 * item's Astra session. Opening the screen asks the host for an existing session; sending an
 * `@Astra` text asks her at once, anything else opens the confirm sheet, whose confirm alone sends.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReviewRef, ReviewsOp } from "@relay/protocol";
import { reviewsRequest, sendCommand } from "@/connection";
import { useReviewsStore } from "@/state/reviews";
import type { ConfirmPost } from "./ConfirmSheet";
import { composerIntent, lastAstraAnswer, type ComposerTarget } from "./model";

export interface PendingPost extends ConfirmPost {
  op: ReviewsOp;
}

export interface ReviewComposer {
  draft: string;
  setDraft: (text: string) => void;
  /** The confirm sheet's post, while it shows. */
  pending: PendingPost | null;
  posting: boolean;
  postError: string | null;
  /** True from an ask until its answer: the session may not have pushed anything yet. */
  asking: boolean;
  askError: string | null;
  /** Whether the Astra panel docks under the composer. */
  showAstra: boolean;
  placeholder: string;
  send: () => void;
  /** Opens the confirm sheet for any post (the PR menu's Approve and Request changes too). */
  confirm: (post: PendingPost) => void;
  post: () => void;
  cancel: () => void;
  /** "Use as reply": Astra's newest answer into the draft; null until she has answered something. */
  takeAnswer: (() => void) | null;
  stop: () => void;
}

export function useReviewComposer(url: string, reference: ReviewRef | null, target: ComposerTarget | null, onPosted: (message: string) => void): ReviewComposer {
  const astra = useReviewsStore((state) => state.astra[url]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingPost | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    void reviewsRequest({ kind: "astra", url });
  }, [url]);

  const confirm = useCallback((post: PendingPost) => {
    setPostError(null);
    setPending(post);
  }, []);

  const send = () => {
    if (target === null || reference === null) return;
    const intent = composerIntent(draft, target);
    if (intent === null) return;
    if (intent.kind === "post") {
      confirm({ op: intent.op, destination: intent.destination, text: intent.op.kind === "slackSend" ? intent.op.text : draft.trim(), action: intent.action });
      return;
    }
    setDraft("");
    setAsking(true);
    setAskError(null);
    void reviewsRequest({ kind: "astraAsk", url, ref: reference, text: intent.text }).then((result) => {
      setAsking(false);
      if (!result.ok) setAskError(result.error ?? "Astra could not take that.");
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
      setPending(null);
      onPosted(pending.op.kind === "slackSend" ? "Handed to Astra to send" : "Posted");
    });
  };

  const answer = lastAstraAnswer(astra);
  const showAstra = asking || askError !== null || (astra !== undefined && astra.turns.length > 0);
  return {
    draft,
    setDraft,
    pending,
    posting,
    postError,
    asking,
    askError,
    showAstra,
    placeholder: showAstra ? "Comment, or @Astra to ask again" : "Comment, or @Astra to ask privately",
    send,
    confirm,
    post,
    cancel: () => {
      setPending(null);
      setPostError(null);
    },
    takeAnswer:
      answer === null
        ? null
        : () => {
            setDraft(answer);
          },
    stop: () => {
      const sessionId = astra?.sessionId ?? null;
      if (sessionId !== null) void sendCommand({ kind: "agent.abort", sessionId }).catch(() => undefined);
    },
  };
}
