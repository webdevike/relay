/**
 * The model picker: every model the host offers outside ComfyUI, grouped under quiet captions
 * (Local, ChatGPT, Paid). A paid model shows its price for the current settings, quoted when the
 * sheet opens (quotes are free); an unavailable one is dimmed with its reason.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { StudioBackend } from "@relay/protocol";
import { spacing } from "@/theme";
import { OptionRow } from "@/ui/OptionRow";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { draftForEntry, draftSpec, STUDIO_GROUPS, studioEntries, studioForm, type StudioDraft, type StudioEntry } from "./draft";
import { fetchQuote, type Quote } from "./quote";

export interface ModelSheetProps {
  visible: boolean;
  draft: StudioDraft;
  backends: readonly StudioBackend[];
  onPick: (entry: StudioEntry) => void;
  onClose: () => void;
}

const keyOf = (entry: Pick<StudioEntry, "backend" | "model">) => `${entry.backend}:${entry.model ?? ""}`;

export function ModelSheet({ visible, draft, backends, onPick, onClose }: ModelSheetProps) {
  const form = studioForm(draft, backends);
  const entries = studioEntries(backends);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const paidKeys = entries.filter((e) => e.paid && e.available).map(keyOf).join("\n");

  useEffect(() => {
    if (!visible) return;
    let live = true;
    for (const entry of entries) {
      if (!entry.paid || !entry.available) continue;
      const spec = draftSpec(studioForm(draftForEntry(draft, entry), backends));
      if (spec === undefined) continue;
      void fetchQuote(spec).then((quote) => {
        if (live) setQuotes((current) => ({ ...current, [keyOf(entry)]: quote }));
      });
    }
    return () => {
      live = false;
    };
    // Quoted once per opening (and when the paid list changes); chips can't change while it is open.
  }, [visible, paidKeys]);

  const balance = Object.values(quotes).find((quote) => quote.ok && quote.balance !== undefined);
  const credits = balance?.ok === true ? balance.balance : backends.find((b) => b.paid)?.balance;

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
        <Text variant="title">Model</Text>
        {STUDIO_GROUPS.map((group) => {
          const inGroup = entries.filter((e) => e.group === group);
          if (inGroup.length === 0) return null;
          return (
            <View key={group} style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              <Text variant="caption" color="textMuted">
                {group === "Paid"
                  ? draft.prompt.trim().length === 0
                    ? "Paid. Type a prompt to see what each model costs."
                    : credits === undefined
                      ? "Paid. Prices for these settings."
                      : `Paid. Prices for these settings, ${credits} credits left.`
                  : group}
              </Text>
              {inGroup.map((entry) => {
                const quote = quotes[keyOf(entry)];
                return (
                  <OptionRow
                    key={keyOf(entry)}
                    label={entry.label}
                    description={entry.available ? entry.description : entry.reason}
                    selected={entry.backend === form.backend?.id && entry.model === form.model?.id}
                    disabled={!entry.available}
                    badge={quote === undefined ? undefined : quote.ok ? `${quote.credits} credits` : "No price"}
                    onPress={() => {
                      onPick(entry);
                    }}
                  />
                );
              })}
            </View>
          );
        })}
      </View>
    </Sheet>
  );
}
