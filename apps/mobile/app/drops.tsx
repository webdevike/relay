/**
 * The shared drop box. The host owns the list (`useDropsStore` mirrors it); this screen only
 * reads it, sends the clipboard up, and acts on rows: a tap does the obvious thing for the kind,
 * a hold opens the full sheet. Image and file bytes are fetched from the host over HTTP through
 * `src/drops/actions`.
 */
import { useEffect, useState } from "react";
import { ActionSheetIOS, FlatList, Linking, View } from "react-native";
import * as Sharing from "expo-sharing";
import type { File } from "expo-file-system";
import type { Drop } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { IconButton } from "@/ui/IconButton";
import { Separator } from "@/ui/Separator";
import { EmptyState } from "@/ui/EmptyState";
import { Banner, type BannerTone } from "@/ui/Banner";
import { spacing } from "@/theme";
import { useDropsStore } from "@/state/drops";
import { useConnectionStore } from "@/state/connection";
import { hostBaseUrl, requestDrops, sendCommand } from "@/connection";
import { copyText, readClipboardImage, readClipboardText } from "@/lib/clipboard";
import { notifyHaptic } from "@/lib/haptics";
import { DropRow } from "@/drops/DropRow";
import { downloadDrop, hasFile, saveToPhotos } from "@/drops/actions";
import { ImageViewer } from "@/agents/ImageViewer";

interface Notice {
  readonly tone: BannerTone;
  readonly message: string;
}

/** A confirmation reads in a glance; a failure stays long enough to actually read. */
const NOTICE_MS: Record<BannerTone, number> = { info: 2_000, warn: 3_500, danger: 5_000 };

interface SheetAction {
  readonly label: string;
  readonly run: () => void;
}

export default function Drops() {
  const drops = useDropsStore((state) => state.drops);
  const hostName = useConnectionStore((state) => state.macName);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    requestDrops();
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_MS[notice.tone]);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  /** Runs `work`, turning a rejection into a danger banner (nack message when there is one). */
  const attempt = (work: () => Promise<void>, fallback: string): void => {
    work().catch((error: unknown) => {
      notifyHaptic("error");
      setNotice({ tone: "danger", message: error instanceof Error && error.message !== "" ? error.message : fallback });
    });
  };

  /** The drop's bytes on the phone, or a rejection that explains why they can't be. */
  const fetchDrop = async (drop: Drop): Promise<File> => {
    const base = hostBaseUrl();
    if (base === null) throw new Error("Not connected.");
    if (!hasFile(drop)) throw new Error("This drop has no file.");
    return downloadDrop(base, drop);
  };

  const copy = (drop: Drop): void => {
    attempt(async () => {
      await copyText(drop.text ?? drop.title);
      notifyHaptic("success");
      setNotice({ tone: "info", message: "Copied" });
    }, "Couldn't copy.");
  };

  const openLink = (drop: Drop): void => {
    attempt(() => Linking.openURL(drop.text ?? drop.title), "Couldn't open the link.");
  };

  const view = (drop: Drop): void => {
    const base = hostBaseUrl();
    if (base === null || !hasFile(drop)) {
      setNotice({ tone: "warn", message: "Not connected" });
      return;
    }
    setViewing(`${base}${drop.file.path}`);
  };

  const share = (drop: Drop): void => {
    attempt(async () => {
      const file = await fetchDrop(drop);
      await Sharing.shareAsync(file.uri);
    }, "Couldn't share the file.");
  };

  const save = (drop: Drop): void => {
    attempt(async () => {
      const file = await fetchDrop(drop);
      if (await saveToPhotos(file)) {
        notifyHaptic("success");
        setNotice({ tone: "info", message: "Saved to Photos" });
      } else {
        setNotice({ tone: "warn", message: "Relay isn't allowed to add to your photos." });
      }
    }, "Couldn't save the image.");
  };

  const remove = (drop: Drop): void => {
    attempt(() => sendCommand({ kind: "drop.delete", id: drop.id }), "Couldn't delete the drop.");
  };

  const sendClipboard = (): void => {
    attempt(async () => {
      const image = await readClipboardImage();
      if (image !== null) {
        await sendCommand({ kind: "drop.put", image: { mimeType: image.mimeType, data: image.data } });
      } else {
        const text = await readClipboardText();
        if (text === null) {
          setNotice({ tone: "warn", message: "Clipboard is empty" });
          return;
        }
        await sendCommand({ kind: "drop.put", text });
      }
      notifyHaptic("success");
      setNotice({ tone: "info", message: "Sent" });
    }, "Couldn't send the clipboard.");
  };

  const open = (drop: Drop): void => {
    switch (drop.kind) {
      case "text":
        copy(drop);
        return;
      case "link":
        openLink(drop);
        return;
      case "image":
        view(drop);
        return;
      case "file":
        share(drop);
        return;
    }
  };

  const showSheet = (drop: Drop): void => {
    const actions: SheetAction[] = [];
    if (drop.kind === "text" || drop.kind === "link") actions.push({ label: "Copy", run: () => { copy(drop); } });
    if (drop.kind === "link") actions.push({ label: "Open", run: () => { openLink(drop); } });
    if (drop.kind === "image") actions.push({ label: "Save to Photos", run: () => { save(drop); } });
    if (drop.kind === "image" || drop.kind === "file") actions.push({ label: "Share", run: () => { share(drop); } });
    actions.push({ label: "Delete", run: () => { remove(drop); } });
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: drop.title,
        options: [...actions.map((action) => action.label), "Cancel"],
        destructiveButtonIndex: actions.length - 1,
        cancelButtonIndex: actions.length,
        userInterfaceStyle: "dark",
      },
      (index) => {
        actions[index]?.run();
      },
    );
  };

  return (
    <Screen title="Drops" headerRight={<IconButton symbol="square.and.arrow.up" onPress={sendClipboard} />}>
      {notice !== null && (
        <View style={{ paddingBottom: spacing.lg }}>
          <Banner tone={notice.tone} message={notice.message} />
        </View>
      )}
      {drops.length === 0 ? (
        <EmptyState
          symbol="tray.and.arrow.down"
          title="Nothing shared yet"
          body="Share from the host with relay share, or send your clipboard from here."
        />
      ) : (
        <FlatList
          data={drops}
          keyExtractor={(drop) => drop.id}
          ItemSeparatorComponent={Separator}
          ListHeaderComponent={Separator}
          ListFooterComponent={Separator}
          renderItem={({ item }) => <DropRow drop={item} hostName={hostName} onPress={open} onLongPress={showSheet} />}
        />
      )}
      <ImageViewer
        uri={viewing}
        onClose={() => {
          setViewing(null);
        }}
      />
    </Screen>
  );
}
