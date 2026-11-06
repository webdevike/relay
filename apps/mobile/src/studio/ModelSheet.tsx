/**
 * The create bar's model picker: the models that make originals, grouped under quiet captions
 * (Local, ChatGPT, Paid). A paid model shows its price for the current prompt and aspect, quoted
 * when the sheet opens (quotes are free); an unavailable one is dimmed with its reason.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { StudioBackend } from "@relay/protocol";
import { spacing } from "@/theme";
import { OptionRow } from "@/ui/OptionRow";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { CREATE_GROUPS, createSpec, type CreateDraft, type CreateEntry } from "./create";
import { fetchQuote, type Quote } from "./quote";

export interface ModelSheetProps {
  visible: boolean;
  draft: CreateDraft;
  entries: readonly CreateEntry[];
  selected: CreateEntry | undefined;
  backends: readonly StudioBackend[];
  onPick: (entry: CreateEntry) => void;
  onClose: () => void;
}

export function ModelSheet({ visible, draft, entries, selected, backends, onPick, onClose }: ModelSheetProps) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const paidKeys = entries
    .filter((e) => e.paid && e.available)
    .map((e) => e.key)
    .join("\n");

  useEffect(() => {
    if (!visible) return;
    let live = true;
    for (const entry of entries) {
      if (!entry.paid || !entry.available) continue;
      const spec = createSpec(draft, entry, backends);
      if (spec === undefined) continue;
      void fetchQuote(spec).then((quote) => {
        if (live) setQuotes((current) => ({ ...current, [entry.key]: quote }));
      });
    }
    return () => {
      live = false;
    };
    // Quoted once per opening (and when the paid list changes); the draft can't change while it is open.
  }, [visible, paidKeys]);

  const balance = Object.values(quotes).find((quote) => quote.ok && quote.balance !== undefined);
  const credits = balance?.ok === true ? balance.balance : backends.find((b) => b.paid)?.balance;

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
        <Text variant="title">Create with</Text>
        {CREATE_GROUPS.map((group) => {
          const inGroup = entries.filter((e) => e.group === group);
          if (inGroup.length === 0) return null;
          return (
            <View key={group} style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              <Text variant="caption" color="textMuted">
                {group === "Paid"
                  ? draft.prompt.trim().length === 0
                    ? "Paid. Type a prompt to see what each model costs."
                    : credits === undefined
                      ? "Paid. One image per Generate."
                      : `Paid. One image per Generate, ${credits} credits left.`
                  : group}
              </Text>
              {inGroup.map((entry) => {
                const quote = quotes[entry.key];
                return (
                  <OptionRow
                    key={entry.key}
                    label={entry.label}
                    description={entry.available ? undefined : entry.reason}
                    selected={entry.key === selected?.key}
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
