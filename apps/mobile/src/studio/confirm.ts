/**
 * Studio's delete confirmations, native alerts (they work over the editor's full-screen modal). Deleting
 * an image takes every version made from it too, so each says how many images go.
 */
import { Alert } from "react-native";
import { imageCount } from "./library";

const UNDO_NOTE = "Your Mac deletes the files after the undo window.";

function versionsNote(total: number, selected: number): string {
  const extra = total - selected;
  return extra > 0 ? `That is ${imageCount(selected)} and the ${extra} ${extra === 1 ? "edit" : "edits"} made from ${selected === 1 ? "it" : "them"}. ${UNDO_NOTE}` : UNDO_NOTE;
}

/** One confirm for `total` images going (the `selected` ones and everything made from them); false on Cancel. */
export function confirmDelete(total: number, selected: number): Promise<boolean> {
  // Executor form: Hermes on the phone predates Promise.withResolvers.
  return new Promise((resolve) => {
    Alert.alert(`Delete ${imageCount(total)}?`, versionsNote(total, selected), [
      {
        text: "Cancel",
        style: "cancel",
        onPress: () => {
          resolve(false);
        },
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          resolve(true);
        },
      },
    ], {
      cancelable: true,
      onDismiss: () => {
        resolve(false);
      },
    });
  });
}

export type DeleteScope = "version" | "all";

/** The editor's confirm: this version with the edits made from it, or the whole image with every version; null on Cancel. */
export function chooseDeleteScope(version: number, all: number): Promise<DeleteScope | null> {
  return new Promise((resolve) => {
    Alert.alert(`Delete ${imageCount(all)}?`, `Choose what goes. ${UNDO_NOTE}`, [
      {
        text: "Cancel",
        style: "cancel",
        onPress: () => {
          resolve(null);
        },
      },
      {
        text: `This version${version > 1 ? ` and its ${version - 1} ${version === 2 ? "edit" : "edits"}` : ""}`,
        style: "destructive",
        onPress: () => {
          resolve("version");
        },
      },
      {
        text: `All ${imageCount(all)}`,
        style: "destructive",
        onPress: () => {
          resolve("all");
        },
      },
    ], {
      cancelable: true,
      onDismiss: () => {
        resolve(null);
      },
    });
  });
}
