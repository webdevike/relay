import { View } from "react-native";
import { useSelector } from "@xstate/react";
import type { SnapshotFrom } from "xstate";
import { spacing } from "@/theme";
import { ActionToast } from "./ActionToast";
import { cardUndoActor } from "./cardUndo";
import type { cardUndoMachine } from "./cardUndo.machine";

const offered = (snapshot: SnapshotFrom<typeof cardUndoMachine>): string | null => (snapshot.matches("offering") ? snapshot.context.message : null);

/** The Undo offer after a status card was dismissed; nothing while none is on offer. The screen places it. */
export function CardUndoToast() {
  const message = useSelector(cardUndoActor, offered);
  if (message === null) return null;
  return (
    <View style={{ paddingBottom: spacing.sm }}>
      <ActionToast
        message={message}
        action="Undo"
        onAction={() => {
          cardUndoActor.send({ type: "card.undo" });
        }}
      />
    </View>
  );
}
