import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { AgentModel, AgentSkill, AgentSkillChoice, Command } from "@relay/protocol";
import { Sheet, SheetScrollView, SheetTextInput } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { colors, radii, spacing, type } from "@/theme";
import { useAgentsStore } from "@/state/agents";
import { requestAgentOptions, sendCommand } from "@/connection";
import { dictationActor } from "@/dictation/actor";
import { useDictation } from "@/dictation/useDictation";
import { VendorLogo, vendorLabel } from "./VendorLogo";
import { tapHaptic } from "@/lib/haptics";

const LIST_MAX_HEIGHT = 260;

export interface AgentSettingsSheetProps {
  sessionId: string | null;
  onClose: () => void;
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text variant="label" color={selected ? "accent" : "textMuted"}>
        {label}
      </Text>
    </Pressable>
  );
}

function ModelRow({
  model,
  selected,
  onPress,
}: {
  model: AgentModel;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}>
      <View style={{ flex: 1 }}>
        <Text variant="body" numberOfLines={1}>
          {model.name}
        </Text>
        {model.provider !== model.vendor && (
          <Text variant="caption" color="textFaint" numberOfLines={1}>
            via {model.provider}
          </Text>
        )}
      </View>
      {selected && <SymbolView name="checkmark" size={16} tintColor={colors.accent} />}
    </Pressable>
  );
}

/** A collapsible group: header row with a chevron, children below while open. */
function Accordion({
  open,
  onToggle,
  leading,
  title,
  subtitle,
  nested = false,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  leading?: React.ReactNode;
  title: string;
  subtitle?: string | undefined;
  nested?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View>
      <Pressable
        onPress={() => {
          tapHaptic();
          onToggle();
        }}
        style={({ pressed }) => [
          styles.row,
          nested && styles.rowNested,
          pressed && { opacity: 0.8 },
        ]}
      >
        {leading}
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={1}>
            {title}
          </Text>
          {subtitle !== undefined && (
            <Text variant="caption" color="textFaint" numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={13}
          tintColor={colors.textFaint}
        />
      </Pressable>
      {open && <View style={styles.accordionBody}>{children}</View>}
    </View>
  );
}

/**
 * One command on the skill list. Text-taking commands arm the next dictation (mic glyph); the rest
 * are complete on their own and go straight to the session (send glyph).
 */
function SkillRow({
  entry,
  armed,
  nested,
  onPress,
}: {
  entry: AgentSkillChoice;
  armed: boolean;
  nested: boolean;
  onPress: () => void;
}) {
  const glyph: SFSymbol = entry.takesText ? "mic" : "paperplane";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, nested && styles.rowNested, pressed && { opacity: 0.8 }]}
    >
      <View style={{ flex: 1 }}>
        <Text variant="body" numberOfLines={1}>
          {entry.name}
        </Text>
        {entry.description.length > 0 && (
          <Text variant="caption" color="textFaint" numberOfLines={1}>
            {entry.description}
          </Text>
        )}
      </View>
      {armed ? (
        <SymbolView name="checkmark" size={16} tintColor={colors.accent} />
      ) : (
        <SymbolView name={glyph} size={14} tintColor={colors.textFaint} />
      )}
    </Pressable>
  );
}

/**
 * Long-press target for a scrubber slot: rename the session, pick its model (one accordion per
 * company) and thinking level, point the next dictation at a skill or fire a subcommand, or stop
 * what it is doing. Each change is sent as soon as it is made; the card updates when the host
 * reports the new settings back.
 */
export function AgentSettingsSheet({ sessionId, onClose }: AgentSettingsSheetProps) {
  const session = useAgentsStore((state) =>
    sessionId === null ? undefined : state.sessions[sessionId],
  );
  const options = useAgentsStore((state) =>
    sessionId === null ? undefined : state.options[sessionId],
  );
  const armed = useDictation().skill;
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    setTitle(useAgentsStore.getState().sessions[sessionId]?.title ?? "");
    setOpenVendor(null);
    setSkillsOpen(false);
    setOpenSkill(null);
    setError(null);
    requestAgentOptions(sessionId);
  }, [sessionId]);

  if (sessionId === null || session === undefined) return null;

  const apply = (cmd: Command, then?: () => void): void => {
    setBusy(true);
    setError(null);
    sendCommand(cmd)
      .then(then)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The host rejected that change.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const commitTitle = (): void => {
    const next = title.trim();
    if (next.length === 0 || next === session.title) {
      setTitle(session.title);
      return;
    }
    apply({ kind: "agent.configure", sessionId, title: next });
  };

  /** A leaf on the skill list: arm it for the next dictation, or send it now when it is complete. */
  const pickSkill = (entry: AgentSkillChoice): void => {
    tapHaptic();
    setSkillsOpen(false);
    if (entry.takesText) {
      dictationActor.send({ type: "arm", skill: armed === entry.command ? null : entry.command });
      return;
    }
    apply({ kind: "agent.reply", sessionId, text: entry.command, submit: true });
  };

  const models = options?.models;
  const skills = options?.skills;
  const current = models?.find((model) => model.name === session.model);
  const thinkingLevels =
    current?.thinkingLevels ?? (session.thinkingLevel === undefined ? [] : [session.thinkingLevel]);
  const armedName = skills === undefined || armed === null ? undefined : skillNameOf(skills, armed);

  return (
    <Sheet visible onClose={onClose}>
      <Section label="Title">
        <SheetTextInput
          value={title}
          onChangeText={setTitle}
          onBlur={commitTitle}
          onSubmitEditing={commitTitle}
          placeholder={session.title}
          placeholderTextColor={colors.textFaint}
          autoCorrect={false}
          returnKeyType="done"
          style={styles.input}
        />
      </Section>
      <Section label="Directory">
        <Text variant="body" color="textMuted" numberOfLines={2} selectable>
          {session.projectPath}
        </Text>
      </Section>
      <Section label="Thinking" trailing={thinkingLevels.length === 0 ? "Not reported" : undefined}>
        <View style={styles.chips}>
          {thinkingLevels.map((level) => (
            <Chip
              key={level}
              label={level}
              selected={level === session.thinkingLevel}
              onPress={() => {
                apply({ kind: "agent.configure", sessionId, thinkingLevel: level });
              }}
            />
          ))}
        </View>
      </Section>
      <Section label="Model" trailing={session.model ?? "Not reported"}>
        {models === undefined ? (
          <Text variant="caption" color="textFaint" style={styles.note}>
            Loading models…
          </Text>
        ) : models.length === 0 ? (
          <Text variant="caption" color="textFaint" style={styles.note}>
            No other models available on the host.
          </Text>
        ) : (
          <View style={styles.list}>
            {groupByVendor(models).map(([vendor, group]) => {
              const own = group.find((model) => model.name === session.model);
              return (
                <Accordion
                  key={vendor}
                  open={openVendor === vendor}
                  onToggle={() => {
                    setOpenVendor((open) => (open === vendor ? null : vendor));
                  }}
                  leading={<VendorLogo vendor={vendor} size={16} />}
                  title={vendorLabel(vendor)}
                  subtitle={own?.name}
                >
                  {group.map((model) => (
                    <ModelRow
                      key={`${model.provider}/${model.id}`}
                      model={model}
                      selected={model.name === session.model}
                      onPress={() => {
                        setOpenVendor(null);
                        apply({
                          kind: "agent.configure",
                          sessionId,
                          model: { provider: model.provider, id: model.id },
                        });
                      }}
                    />
                  ))}
                </Accordion>
              );
            })}
          </View>
        )}
      </Section>
      <Section
        label="Skill"
        trailing={armedName === undefined ? "None armed" : `${armedName} armed`}
      >
        <Pressable
          onPress={() => {
            tapHaptic();
            setSkillsOpen((open) => !open);
          }}
          style={({ pressed }) => [styles.dropdown, pressed && { opacity: 0.8 }]}
        >
          <SymbolView
            name={armed === null ? "command" : "mic"}
            size={14}
            tintColor={armed === null ? colors.textFaint : colors.accent}
          />
          <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
            {armed ?? "Pick a skill or command"}
          </Text>
          <SymbolView
            name={skillsOpen ? "chevron.up" : "chevron.down"}
            size={13}
            tintColor={colors.textFaint}
          />
        </Pressable>
        {skillsOpen &&
          (skills === undefined ? (
            <Text variant="caption" color="textFaint" style={styles.note}>
              Loading skills…
            </Text>
          ) : skills.length === 0 ? (
            <Text variant="caption" color="textFaint" style={styles.note}>
              This session offers no skills or commands.
            </Text>
          ) : (
            <SheetScrollView
              style={styles.scrollList}
              contentContainerStyle={styles.listContent}
              bounces={false}
            >
              {armed !== null && (
                <Pressable
                  onPress={() => {
                    tapHaptic();
                    setSkillsOpen(false);
                    dictationActor.send({ type: "arm", skill: null });
                  }}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
                >
                  <Text variant="body" color="textMuted" style={{ flex: 1 }}>
                    None
                  </Text>
                  <SymbolView name="xmark" size={14} tintColor={colors.textFaint} />
                </Pressable>
              )}
              {skills.map((skill) =>
                skill.choices !== undefined && skill.choices.length > 0 ? (
                  <Accordion
                    key={skill.command}
                    open={openSkill === skill.command}
                    onToggle={() => {
                      setOpenSkill((open) => (open === skill.command ? null : skill.command));
                    }}
                    title={skill.name}
                    subtitle={skill.description.length > 0 ? skill.description : undefined}
                  >
                    {skill.takesText && (
                      <SkillRow
                        entry={skill}
                        armed={armed === skill.command}
                        nested
                        onPress={() => {
                          pickSkill(skill);
                        }}
                      />
                    )}
                    {skill.choices.map((choice) => (
                      <SkillRow
                        key={choice.command}
                        entry={choice}
                        armed={armed === choice.command}
                        nested
                        onPress={() => {
                          pickSkill(choice);
                        }}
                      />
                    ))}
                  </Accordion>
                ) : (
                  <SkillRow
                    key={skill.command}
                    entry={skill}
                    armed={armed === skill.command}
                    nested={false}
                    onPress={() => {
                      pickSkill(skill);
                    }}
                  />
                ),
              )}
            </SheetScrollView>
          ))}
      </Section>
      {error !== null && (
        <View style={{ marginTop: spacing.md }}>
          <Banner tone="danger" message={error} />
        </View>
      )}
      <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
        {session.status === "working" && (
          <Button
            label="Stop this turn"
            variant="secondary"
            loading={busy}
            onPress={() => {
              apply({ kind: "agent.abort", sessionId });
            }}
          />
        )}
        {session.status !== "ended" && (
          <Button
            label="End session"
            variant="danger"
            loading={busy}
            onPress={() => {
              Alert.alert(
                "End this session?",
                `omp quits and "${session.title}" closes. Anything it is doing stops.`,
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "End session",
                    style: "destructive",
                    onPress: () => {
                      apply({ kind: "agent.end", sessionId }, onClose);
                    },
                  },
                ],
              );
            }}
          />
        )}
      </View>
    </Sheet>
  );
}

function Section({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text variant="label" color="textMuted">
          {label}
        </Text>
        {trailing !== undefined && (
          <Text variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
            {trailing}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}

/** Keeps the host's order (vendor, then newest first) while bucketing rows under their vendor. */
function groupByVendor(models: AgentModel[]): [string, AgentModel[]][] {
  const groups = new Map<string, AgentModel[]>();
  for (const model of models) {
    const group = groups.get(model.vendor);
    if (group === undefined) groups.set(model.vendor, [model]);
    else group.push(model);
  }
  return [...groups.entries()];
}

/** Display name for an armed command token, searching parents and their choices. */
function skillNameOf(skills: AgentSkill[], command: string): string {
  for (const skill of skills) {
    if (skill.command === command) return skill.name;
    const choice = skill.choices?.find((entry) => entry.command === command);
    if (choice !== undefined) return `${skill.name} ${choice.name}`;
  }
  return command;
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.xl, gap: spacing.sm },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  input: {
    ...type.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  vendor: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  chipSelected: { borderColor: colors.accent },
  dropdown: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  note: { paddingHorizontal: spacing.md },
  list: {
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: "hidden",
  },
  scrollList: {
    maxHeight: LIST_MAX_HEIGHT,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  listContent: { paddingVertical: spacing.xs },
  accordionBody: {
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowNested: { paddingLeft: spacing.xl + spacing.sm },
});
