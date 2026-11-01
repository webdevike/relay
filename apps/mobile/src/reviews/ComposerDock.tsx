/** The bottom of an item's screen: the composer, the Astra panel docked under it, and the confirm sheet. */
import { useRouter } from "expo-router";
import { AstraPanel } from "./AstraPanel";
import { Composer } from "./Composer";
import { ConfirmSheet } from "./ConfirmSheet";
import type { ReviewComposer } from "./useReviewComposer";
import { useReviewsStore } from "@/state/reviews";

export interface ComposerDockProps {
  url: string;
  composer: ReviewComposer;
  /** Overrides the composer's own placeholder (Slack's "Reply in thread"). */
  placeholder?: string | undefined;
  hint?: string | undefined;
  replyingTo?: string | null | undefined;
  onClearReply?: (() => void) | undefined;
}

export function ComposerDock({ url, composer, placeholder, hint, replyingTo, onClearReply }: ComposerDockProps) {
  const router = useRouter();
  const astra = useReviewsStore((state) => state.astra[url]);
  return (
    <>
      <Composer
        value={composer.draft}
        onChange={composer.setDraft}
        onSend={composer.send}
        placeholder={placeholder ?? composer.placeholder}
        hint={hint}
        replyingTo={replyingTo}
        onClearReply={onClearReply}
      />
      {composer.showAstra && (
        <AstraPanel
          item={astra}
          asking={composer.asking}
          askError={composer.askError}
          onUseAsReply={composer.takeAnswer}
          onStop={composer.stop}
          onOpenSession={(sessionId) => {
            router.push({ pathname: "/agents/[sessionId]", params: { sessionId } });
          }}
        />
      )}
      <ConfirmSheet post={composer.pending} busy={composer.posting} error={composer.postError} onCancel={composer.cancel} onConfirm={composer.post} />
    </>
  );
}
