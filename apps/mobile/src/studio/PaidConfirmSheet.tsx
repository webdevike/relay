/**
 * The only way a paid job starts: asks the host for a fresh price when it opens, shows it with the
 * balance before and after, and its primary button hands that exact number to `onConfirm`, which
 * sends the one `create` carrying it. Nothing here is remembered for the next job.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import type { StudioSpec } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { fetchQuote, type Quote } from "./quote";

export interface PaidConfirmSheetProps {
  /** The job to price and confirm; null keeps the sheet closed. */
  spec: StudioSpec | null;
  /** Who gets paid, e.g. "Higgsfield". */
  provider: string;
  /** Balance the backend reported, used when the quote leaves it out. */
  balance: number | undefined;
  sending: boolean;
  /** The host refused the create (e.g. the price went up); shown under the price. */
  error: string | null;
  onConfirm: (credits: number) => void;
  onClose: () => void;
}

export function PaidConfirmSheet({ spec, provider, balance, sending, error, onConfirm, onClose }: PaidConfirmSheetProps) {
  const colors = useColors();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setQuote(null);
    if (spec === null) return;
    let live = true;
    void fetchQuote(spec, { fresh: true }).then((answer) => {
      if (live) setQuote(answer);
    });
    return () => {
      live = false;
    };
  }, [spec, attempt]);

  const before = quote?.ok === true ? (quote.balance ?? balance) : balance;
  const credits = quote?.ok === true ? quote.credits : undefined;

  return (
    <Sheet visible={spec !== null} onClose={onClose}>
      <View style={{ gap: spacing.lg, paddingTop: spacing.sm }}>
        {quote === null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 }}>
            <ActivityIndicator color={colors.textMuted} />
            <Text variant="body" color="textMuted">
              {`Asking ${provider} for the price`}
            </Text>
          </View>
        ) : credits === undefined ? (
          <View style={{ gap: spacing.xs }}>
            <Text variant="title">No price yet</Text>
            <Text variant="body" color="textMuted">
              {quote.ok ? "" : quote.error}
            </Text>
          </View>
        ) : (
          <View style={{ gap: spacing.xs }}>
            <Text variant="title">{`Spend ${credits} credits on ${provider}?`}</Text>
            {before !== undefined && (
              <Text variant="body" color="textMuted" tabular>
                {`Balance ${before} credits, ${before - credits} after this job.`}
              </Text>
            )}
          </View>
        )}
        {error !== null && (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        )}
        <View style={{ gap: spacing.sm }}>
          {credits === undefined ? (
            <Button
              label="Try again"
              height={50}
              disabled={quote === null}
              onPress={() => {
                setAttempt((n) => n + 1);
              }}
            />
          ) : (
            <Button
              label={`Spend ${credits} credits`}
              height={50}
              loading={sending}
              onPress={() => {
                onConfirm(credits);
              }}
            />
          )}
          <Button label="Cancel" variant="secondary" height={50} onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
