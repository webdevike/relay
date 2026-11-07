/**
 * The create bar under the grid: one borderless prompt surface, Image or Video, "Create with" and
 * the model, the aspect, how many (1 to 4 images, one for a paid model or a video), where the
 * output lands, and Generate. Images can carry references (an edit, as on desktop); a video shows
 * its model's sizes and lengths and takes keyframes and references where the model lists them.
 * Free models start at once; a paid one opens the confirm sheet. Shows the store's draft; every
 * change goes back to it.
 */
import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { STUDIO_UNSORTED, type StudioMode, type StudioSpec } from "@relay/protocol";
import { studioRequest } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { spacing, useColors, useScheme, withAlpha } from "@/theme";
import { Button } from "@/ui/Button";
import { MenuButton } from "@/ui/MenuButton";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import { toast } from "./actions";
import { chosenEntry, createCount, createEntries, createOp, createPlan, createTarget, refLimit, STUDIO_ASPECTS, videoSettings } from "./create";
import { ImageSheet } from "./ImageSheet";
import { imageCount, sameView } from "./library";
import { ModelSheet } from "./ModelSheet";
import { PaidConfirmSheet } from "./PaidConfirmSheet";
import { chooseFrom, pickProject } from "./pickers";
import { useQuote, type Quote } from "./quote";

const MODES: readonly { key: StudioMode; label: string }[] = [
  { key: "image", label: "Image" },
  { key: "video", label: "Video" },
];

/** "1 image", "2 images" for the chip that opens the picker; `none` when empty. */
function picked(n: number, none: string): string {
  return n === 0 ? none : n === 1 ? "1 image" : `${n} images`;
}

const COUNTS = [
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "4", label: "4" },
] as const;

/** Opaque card fill in dark mode, as the floating composer pills use. */
const FILL_DARK = "#202020";

/** "12 credits, 488 left" from a quote and the backend's balance. */
function quoteLine(quote: Quote | undefined, balance: number | undefined): string {
  if (quote === undefined) return "Pricing";
  if (!quote.ok) return quote.error;
  const left = quote.balance ?? balance;
  return left === undefined ? `${quote.credits} credits` : `${quote.credits} credits, ${left} left`;
}

const planProblem = (plan: ReturnType<typeof createPlan>): string | undefined => (typeof plan === "string" ? plan : undefined);

export function CreateBar() {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const draft = useStudioStore((state) => state.create);
  const backends = useStudioStore((state) => state.backends);
  const projects = useStudioStore((state) => state.projects);
  const view = useStudioStore((state) => state.view);
  const patch = useStudioStore((state) => state.patchCreate);
  const [models, setModels] = useState(false);
  const [sending, setSending] = useState(false);
  const references = useStudioStore((state) => state.references);
  const [confirm, setConfirm] = useState<{ spec: StudioSpec; error: string | null } | null>(null);
  /** Which picker is open: the references, or a video keyframe. */
  const [picking, setPicking] = useState<"refs" | "start" | "end" | null>(null);

  const video = draft.mode === "video";
  const entries = useMemo(() => createEntries(backends, draft.mode), [backends, draft.mode]);
  const chosen = chosenEntry(draft, entries);
  const count = createCount(draft, chosen);
  const target = createTarget(draft, view, projects);
  const plan = createPlan(draft, chosen, backends, references);
  const problem = typeof plan === "string" ? plan : undefined;
  const spec = typeof plan === "string" ? undefined : plan.spec;
  const settings = video ? videoSettings(draft, chosen, backends) : undefined;
  const refMax = refLimit(draft, chosen, backends);
  const paid = chosen?.paid === true;
  const quote = useQuote(spec, paid);
  const balance = backends.find((b) => b.id === chosen?.backend)?.balance;
  // An empty prompt needs no words (the placeholder asks); anything else in the way does, and a paid model shows its price.
  const hint = problem !== undefined ? (draft.prompt.trim().length === 0 ? planProblem(createPlan({ ...draft, prompt: "-" }, chosen, backends, references)) : problem) : paid ? quoteLine(quote, balance) : undefined;

  const send = async (made: Exclude<ReturnType<typeof createPlan>, string>): Promise<string | null> => {
    setSending(true);
    const result = await studioRequest(createOp(made.spec, count, target.id, made.parent));
    setSending(false);
    if (!result.ok) return result.error ?? "Your Mac did not start it.";
    const store = useStudioStore.getState();
    const landing = { kind: "project", id: target.id } as const;
    // From Favorites the new images would not show; elsewhere say where they went when it is not here.
    if (store.view.kind === "favorites") store.setView(target.id === STUDIO_UNSORTED ? { kind: "all" } : landing);
    else if (store.view.kind !== "all" && !sameView(store.view, landing)) {
      toast(`Queued in ${target.name}`, {
        label: "Open",
        run: () => {
          useStudioStore.getState().setView(landing);
        },
      });
    } else toast(video ? "Queued a video" : `Queued ${imageCount(count)}`);
    // What rode along was for that one job.
    patch({ refs: [], start: undefined, end: undefined });
    return null;
  };

  const generate = async () => {
    if (typeof plan === "string") return;
    // Paid jobs never start from here: the confirm sheet prices them and Isaac taps to spend.
    if (paid) {
      setConfirm({ spec: plan.spec, error: null });
      return;
    }
    const error = await send(plan);
    if (error !== null) toast(error);
  };

  const pickFrame = (slot: "start" | "end") => (ids: string[]) => {
    patch({ [slot]: ids[0] });
  };

  return (
    <View style={{ borderRadius: 18, backgroundColor: dark ? FILL_DARK : colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
      <View style={{ width: 168, paddingTop: spacing.xs }} accessibilityLabel="Make an image or a video">
        <SegmentedTabs
          tabs={MODES}
          value={draft.mode}
          onChange={(mode) => {
            patch({ mode });
          }}
        />
      </View>
      <TextInput
        value={draft.prompt}
        onChangeText={(prompt) => {
          patch({ prompt });
        }}
        placeholder={video ? "Describe the video" : "Describe what to make"}
        placeholderTextColor={withAlpha(colors.text, 0.6)}
        multiline
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        accessibilityLabel={video ? "Describe the video" : "Describe what to make"}
        style={{ color: colors.text, fontSize: 15, lineHeight: 20, minHeight: 40, maxHeight: 120, paddingTop: spacing.sm, paddingBottom: spacing.xs, paddingHorizontal: spacing.xs }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
        <Text variant="caption" color="textMuted" style={{ paddingLeft: spacing.xs }}>
          Create with
        </Text>
        <MenuButton
          label={chosen?.label ?? "No model"}
          accessibilityLabel="Model"
          onPress={() => {
            setModels(true);
          }}
        />
        <MenuButton
          label={draft.aspect}
          accessibilityLabel="Aspect ratio"
          onPress={() => {
            void chooseFrom("Aspect ratio", STUDIO_ASPECTS).then((index) => {
              const aspect = index === null ? undefined : STUDIO_ASPECTS[index];
              if (aspect !== undefined) patch({ aspect });
            });
          }}
        />
        {settings !== undefined && (
          <>
            <MenuButton
              label={settings.resolution?.label ?? "No size"}
              accessibilityLabel="Video size"
              disabled={settings.resolutions.length < 2}
              onPress={() => {
                void chooseFrom(
                  "Video size",
                  settings.resolutions.map((r) => (r.label === r.id ? r.id : `${r.label}, ${r.id}`)),
                ).then((index) => {
                  const resolution = index === null ? undefined : settings.resolutions[index];
                  if (resolution !== undefined) patch({ resolution: resolution.id });
                });
              }}
            />
            <MenuButton
              label={settings.length === undefined ? "No length" : `${settings.length} s`}
              accessibilityLabel="Video length"
              disabled={settings.seconds.length < 2}
              onPress={() => {
                void chooseFrom(
                  "Video length",
                  settings.seconds.map((s) => `${s} seconds`),
                ).then((index) => {
                  const seconds = index === null ? undefined : settings.seconds[index];
                  if (seconds !== undefined) patch({ seconds });
                });
              }}
            />
          </>
        )}
      </View>
      {(refMax > 0 || (settings?.frames.length ?? 0) > 0) && (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
          {settings?.frames.includes("start") === true && (
            <MenuButton
              label={draft.start === undefined ? "Start frame" : "Start frame set"}
              symbol="photo"
              color={draft.start === undefined ? "textMuted" : "text"}
              accessibilityLabel="Start frame"
              onPress={() => {
                setPicking("start");
              }}
            />
          )}
          {settings?.frames.includes("end") === true && (
            <MenuButton
              label={draft.end === undefined ? "End frame" : "End frame set"}
              symbol="photo"
              color={draft.end === undefined ? "textMuted" : "text"}
              accessibilityLabel="End frame"
              onPress={() => {
                setPicking("end");
              }}
            />
          )}
          {refMax > 0 && (
            <MenuButton
              label={picked(draft.refs.length, video ? "Add reference" : "Edit an image")}
              symbol="photo.on.rectangle"
              color={draft.refs.length === 0 ? "textMuted" : "text"}
              accessibilityLabel="Reference images"
              onPress={() => {
                setPicking("refs");
              }}
            />
          )}
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        {!paid && !video && (
          <View style={{ width: 128 }} accessibilityLabel="Image count">
            <SegmentedTabs
              tabs={COUNTS}
              value={String(count) as (typeof COUNTS)[number]["key"]}
              onChange={(key) => {
                patch({ count: Number(key) });
              }}
            />
          </View>
        )}
        <View style={{ flex: 1 }} />
        <MenuButton
          label={target.name}
          symbol={target.id === STUDIO_UNSORTED ? "tray" : "folder"}
          color="textMuted"
          accessibilityLabel={`Save to ${target.name}`}
          onPress={() => {
            void pickProject("Save to", projects, true).then((choice) => {
              if (choice !== null) patch({ target: choice.kind === "follow" ? null : choice.id });
            });
          }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingBottom: spacing.xs }}>
        <Button
          label={paid ? "Generate" : video ? "Generate video" : `Generate ${count}`}
          symbol="sparkles"
          pill
          height={38}
          disabled={problem !== undefined}
          loading={sending && confirm === null}
          onPress={() => {
            void generate();
          }}
        />
        {hint !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={2} style={{ flex: 1 }}>
            {hint}
          </Text>
        )}
      </View>

      <ModelSheet
        visible={models}
        draft={draft}
        entries={entries}
        selected={chosen}
        backends={backends}
        onPick={(entry) => {
          patch({ entry: entry.key });
          setModels(false);
        }}
        onClose={() => {
          setModels(false);
        }}
      />
      <ImageSheet
        visible={picking !== null}
        title={picking === "start" ? "Start frame" : picking === "end" ? "End frame" : video ? "Reference images" : "Edit with images"}
        selected={picking === "start" ? (draft.start === undefined ? [] : [draft.start]) : picking === "end" ? (draft.end === undefined ? [] : [draft.end]) : draft.refs}
        max={picking === "refs" ? refMax : 1}
        onChange={(ids) => {
          if (picking === "start" || picking === "end") pickFrame(picking)(ids);
          else patch({ refs: ids });
        }}
        onClose={() => {
          setPicking(null);
        }}
      />
      <PaidConfirmSheet
        spec={confirm?.spec ?? null}
        provider={(backends.find((b) => b.id === chosen?.backend)?.label ?? "Higgsfield").replace(/\s*\(.*\)$/, "")}
        balance={balance}
        sending={sending}
        error={confirm?.error ?? null}
        onConfirm={(credits) => {
          const confirmed = createPlan(draft, chosen, backends, references, credits);
          if (typeof confirmed === "string" || confirm === null) return;
          void send(confirmed).then((error) => {
            // Refused (the price rose, the balance ran out): a new spec object prices it again.
            setConfirm(error === null ? null : { spec: { ...confirm.spec }, error });
          });
        }}
        onClose={() => {
          setConfirm(null);
        }}
      />
    </View>
  );
}
