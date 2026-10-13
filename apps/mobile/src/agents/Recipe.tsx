import { useState } from "react";
import { View } from "react-native";
import { spacing, useColors } from "@/theme";
import { ChecklistRow } from "@/ui/ChecklistRow";
import { LinkButton } from "@/ui/LinkButton";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import type { RecipeSpec } from "./widget";

type Tab = "ingredients" | "details";

/** Checkable shopping list and cooking details in separate tabs. */
export function Recipe({ spec }: { spec: RecipeSpec }) {
  const colors = useColors();
  const [tab, setTab] = useState<Tab>("ingredients");
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  let section: string | undefined;

  const toggle = (index: number, value: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      if (value) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">{spec.title}</Text>
        {spec.meta !== undefined && (
          <Text variant="caption" color="textMuted">
            {spec.meta.join(" · ")}
          </Text>
        )}
      </View>
      <SegmentedTabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "ingredients", label: `Ingredients · ${checked.size}/${spec.ingredients.length}` },
          { key: "details", label: "Details" },
        ]}
      />
      {tab === "ingredients" ? (
        <View>
          {spec.ingredients.map((ingredient, index) => {
            const showSection = ingredient.section !== undefined && ingredient.section !== section;
            section = ingredient.section;
            return (
              <View key={`${ingredient.item}-${index}`}>
                {showSection && (
                  <Text
                    variant="label"
                    color="textMuted"
                    style={{ paddingTop: index === 0 ? 0 : spacing.sm, paddingBottom: spacing.xs }}
                  >
                    {ingredient.section}
                  </Text>
                )}
                <ChecklistRow
                  label={ingredient.item}
                  checked={checked.has(index)}
                  onChange={(value) => toggle(index, value)}
                />
                {index + 1 < spec.ingredients.length && (
                  <View style={{ height: 1, backgroundColor: colors.hairline }} />
                )}
              </View>
            );
          })}
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          {spec.directions.map((direction, index) => (
            <View key={index} style={{ flexDirection: "row", gap: spacing.md }}>
              <Text variant="label" color="accent" style={{ minWidth: 20 }}>
                {index + 1}
              </Text>
              <Text style={{ flex: 1 }}>{direction}</Text>
            </View>
          ))}
          {spec.source !== undefined && (
            <LinkButton label="View original recipe" url={spec.source} />
          )}
        </View>
      )}
    </View>
  );
}
