/**
 * Higgsfield's model picker: every model of the mode with its price for the current settings
 * (quoted when the sheet opens; quotes are free) and the credit balance.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { StudioBackend } from "@relay/protocol";
import { spacing } from "@/theme";
import { OptionRow } from "@/ui/OptionRow";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { draftSpec, studioForm, type StudioDraft } from "./draft";
import { fetchQuote, type Quote } from "./quote";

export interface ModelSheetProps {
  visible: boolean;
  draft: StudioDraft;
  backends: readonly StudioBackend[];
  onPick: (model: string) => void;
  onClose: () => void;
}

export function ModelSheet({ visible, draft, backends, onPick, onClose }: ModelSheetProps) {
  const form = studioForm(draft, backends);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const ids = form.models.map((m) => m.id).join("\n");

  useEffect(() => {
    if (!visible) return;
    let live = true;
    for (const model of form.models) {
      const spec = draftSpec(studioForm({ ...draft, model: model.id }, backends));
      if (spec === undefined) continue;
      void fetchQuote(spec).then((quote) => {
        if (live) setQuotes((current) => ({ ...current, [model.id]: quote }));
      });
    }
    return () => {
      live = false;
    };
    // Quoted once per opening (and when the model list changes); chips can't change while it is open.
  }, [visible, ids]);

  const balance = Object.values(quotes).find((quote) => quote.ok && quote.balance !== undefined);
  const credits = balance?.ok === true ? balance.balance : form.backend?.balance;

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
        <Text variant="title">Model</Text>
        <Text variant="caption" color="textMuted">
          {draft.prompt.trim().length === 0
            ? "Type a prompt to see what each model costs."
            : credits === undefined
              ? "Prices for these settings."
              : `Prices for these settings. ${credits} credits left.`}
        </Text>
        <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
          {form.models.map((model) => {
            const quote = quotes[model.id];
            return (
              <OptionRow
                key={model.id}
                label={model.name}
                selected={model.id === form.model?.id}
                badge={quote === undefined ? undefined : quote.ok ? `${quote.credits} credits` : "No price"}
                onPress={() => {
                  onPick(model.id);
                }}
              />
            );
          })}
        </View>
      </View>
    </Sheet>
  );
}
