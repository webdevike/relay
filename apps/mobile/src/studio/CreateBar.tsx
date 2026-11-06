/**
 * The create bar under the grid: one borderless prompt surface, "Create with" and the model, the
 * aspect, how many (1 to 4, one image for a paid model), where the images land, and Generate.
 * Free models start at once; a paid one opens the confirm sheet. Shows the store's draft; every
 * change goes back to it.
 */
import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { STUDIO_UNSORTED, type StudioSpec } from "@relay/protocol";
import { studioRequest } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { spacing, useColors, useScheme, withAlpha } from "@/theme";
import { Button } from "@/ui/Button";
import { MenuButton } from "@/ui/MenuButton";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import { toast } from "./actions";
import { chosenEntry, createCount, createEntries, createOp, createProblem, createSpec, createTarget, STUDIO_ASPECTS } from "./create";
import { imageCount, sameView } from "./library";
import { ModelSheet } from "./ModelSheet";
import { PaidConfirmSheet } from "./PaidConfirmSheet";
import { chooseFrom, pickProject } from "./pickers";
import { useQuote, type Quote } from "./quote";

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
  const [confirm, setConfirm] = useState<{ spec: StudioSpec; error: string | null } | null>(null);

  const entries = useMemo(() => createEntries(backends), [backends]);
  const chosen = chosenEntry(draft, entries);
  const count = createCount(draft, chosen);
  const target = createTarget(draft, view, projects);
  const problem = createProblem(draft, chosen, backends);
  const paid = chosen?.paid === true;
  const quote = useQuote(createSpec(draft, chosen, backends), paid);
  const balance = backends.find((b) => b.id === chosen?.backend)?.balance;
  // An empty prompt needs no words (the placeholder asks); anything else in the way does, and a paid model shows its price.
  const hint = problem !== undefined ? (draft.prompt.trim().length === 0 ? createProblem({ ...draft, prompt: "-" }, chosen, backends) : problem) : paid ? quoteLine(quote, balance) : undefined;

  const send = async (spec: StudioSpec): Promise<string | null> => {
    setSending(true);
    const result = await studioRequest(createOp(spec, count, target.id));
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
    } else toast(`Queued ${imageCount(count)}`);
    return null;
  };

  const generate = async () => {
    const spec = createSpec(draft, chosen, backends);
    if (spec === undefined) return;
    // Paid jobs never start from here: the confirm sheet prices them and Isaac taps to spend.
    if (paid) {
      setConfirm({ spec, error: null });
      return;
    }
    const error = await send(spec);
    if (error !== null) toast(error);
  };

  return (
    <View style={{ borderRadius: 18, backgroundColor: dark ? FILL_DARK : colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
      <TextInput
        value={draft.prompt}
        onChangeText={(prompt) => {
          patch({ prompt });
        }}
        placeholder="Describe what to make"
        placeholderTextColor={withAlpha(colors.text, 0.6)}
        multiline
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        accessibilityLabel="Describe what to make"
        style={{ color: colors.text, fontSize: 15, lineHeight: 20, minHeight: 40, maxHeight: 120, paddingTop: spacing.sm, paddingBottom: spacing.xs, paddingHorizontal: spacing.xs }}
      />
      <View style={{ flexDirection: "row", alignItems: "center" }}>
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
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        {!paid && (
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
          label={paid ? "Generate" : `Generate ${count}`}
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
      <PaidConfirmSheet
        spec={confirm?.spec ?? null}
        provider={(backends.find((b) => b.id === chosen?.backend)?.label ?? "Higgsfield").replace(/\s*\(.*\)$/, "")}
        balance={balance}
        sending={sending}
        error={confirm?.error ?? null}
        onConfirm={(credits) => {
          const spec = createSpec(draft, chosen, backends, credits);
          if (spec === undefined || confirm === null) return;
          void send(spec).then((error) => {
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
