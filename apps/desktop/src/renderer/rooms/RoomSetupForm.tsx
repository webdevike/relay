import { useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Button,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  TextInput,
  Textarea,
  UnstyledButton,
} from '@mantine/core'
import { IconPlus, IconUsersGroup, IconX } from '@tabler/icons-react'
import {
  ChatRoomSetupSchema,
  OMP_THINKING_LEVELS,
  ROLE_INSTRUCTIONS,
  ROOM_EFFORTS,
  ROOM_MAX_MEMBERS,
  ROOM_TEMPLATES,
  ROOM_TEMPLATE_KEYS,
  fitThinking,
  levelsFor,
  memberIdFor,
  memberProblem,
  templateMembers,
  type Assistant,
  type ChatRoomMember,
  type ChatRoomSetup,
  type OmpThinking,
  type RoomTemplate,
} from '@evaos/contract'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { useAssistants } from '../assistants/assistants-store'
import { thinkingLabel } from '../chat/composer/ModelPicker'
import { startSettings, useSettings } from '../settings/settings-store'
import { portrait } from '../ui/portrait'
import { MemberFace } from './MemberStack'
import { specOf, useModelCatalog } from './model-catalog'
import { RoomModelPicker } from './RoomModelPicker'

interface Draft {
  template: RoomTemplate
  title: string
  members: ChatRoomMember[]
  effort: number
  budget: number | string
  folder: string
  refs: string
  draft?: string
}

/** Field errors by key: `title`, `budget`, `folder`, `refs`, `members`, `member:<i>`. */
type Errors = Record<string, string>

const isLevel = (v: string): v is OmpThinking =>
  (OMP_THINKING_LEVELS as readonly string[]).includes(v)

/** The model a new member starts on: its assistant's registry model, else a starred one, else omp's first. */
function modelPicker(
  models: readonly ModelInfo[],
  favorites: readonly string[],
  assistants: readonly Assistant[],
): (assistant: string | null) => { model: ModelInfo; level: OmpThinking | null } {
  const bySpec = (spec: string): ModelInfo | undefined => models.find((m) => specOf(m) === spec)
  const registry = (
    a: Assistant | undefined,
  ): { model: ModelInfo; level: OmpThinking | null } | null => {
    if (!a?.model) return null
    const [spec = '', level = ''] = a.model.split(':')
    const model = bySpec(spec)
    return model ? { model, level: isLevel(level) ? level : null } : null
  }
  const fallback =
    favorites.map(bySpec).find((m) => m !== undefined) ??
    assistants.map((a) => registry(a)?.model).find((m) => m !== undefined) ??
    models[0]!
  return (assistant) =>
    registry(assistants.find((a) => a.id === assistant)) ?? { model: fallback, level: null }
}

function fromSetup(setup: ChatRoomSetup): Draft {
  return {
    template: setup.template,
    title: setup.title ?? '',
    members: setup.members.map((m) => ({ ...m })),
    effort: setup.effort,
    budget: setup.budget,
    folder: setup.folder ?? '',
    refs: setup.refs.join('\n'),
    ...(setup.draft !== undefined ? { draft: setup.draft } : {}),
  }
}

/**
 * Assembles a chat room (the New room page) or changes one (Members...): a template, an optional
 * title, the members (registry assistants or custom agents, each on an exact omp model with its own
 * thinking level and role), effort and budget, an optional folder and references.
 */
export function RoomSetupForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  /** The room's setup when editing; a new room starts from the Debate template. */
  initial: ChatRoomSetup | null
  submitLabel: string
  /** Resolves with main's refusal, or null once it went through. */
  onSubmit: (setup: ChatRoomSetup) => Promise<string | null>
  onCancel?: () => void
}) {
  const { models, error: catalogError } = useModelCatalog()
  const assistants = useAssistants((s) => s.data?.agents ?? null)
  const favorites = useSettings((s) => s.favorite_models)
  useEffect(() => {
    void startSettings()
  }, [])
  const [form, setForm] = useState<Draft | null>(() => (initial ? fromSetup(initial) : null))
  const [errors, setErrors] = useState<Errors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<string, true>>({})
  const pick = useMemo(
    () =>
      models && models.length > 0 && assistants ? modelPicker(models, favorites, assistants) : null,
    [models, favorites, assistants],
  )

  const preset = (template: RoomTemplate): Draft => {
    const t = ROOM_TEMPLATES[template]
    return {
      template,
      title: form?.title ?? '',
      members: templateMembers(template, assistants ?? [], (a) => pick!(a).model),
      effort: t.effort,
      budget: t.budget,
      folder: form?.folder ?? '',
      refs: form?.refs ?? '',
    }
  }
  useEffect(() => {
    if (form === null && pick !== null) setForm(preset('debate'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, form])

  if (catalogError && !models)
    return (
      <Alert color="red" title="Could not read omp's models" data-testid="room-form-error">
        {catalogError}
      </Alert>
    )
  if (form === null || models === null || assistants === null)
    return <Loader size="sm" data-testid="room-form-loading" />

  const levelsOf = (spec: string): readonly string[] =>
    levelsFor(models.find((m) => specOf(m) === spec))
  const patch = (p: Partial<Draft>): void => setForm({ ...form, ...p })
  const setMember = (i: number, p: Partial<ChatRoomMember>): void =>
    patch({ members: form.members.map((m, j) => (j === i ? { ...m, ...p } : m)) })
  const taken = new Set(form.members.map((m) => m.id))
  const effortThinking = ROOM_EFFORTS[form.effort - 1]!.thinking

  const toggleAssistant = (a: Assistant): void => {
    if (form.members.some((m) => m.assistant === a.id)) {
      patch({ members: form.members.filter((m) => m.assistant !== a.id) })
      return
    }
    if (form.members.length >= ROOM_MAX_MEMBERS) return
    const { model, level } = pick!(a.id)
    patch({
      members: [
        ...form.members,
        {
          id: memberIdFor(a.id, taken),
          assistant: a.id,
          name: a.title,
          model: specOf(model),
          thinking: fitThinking(level ?? effortThinking, levelsFor(model)),
          role: '',
        },
      ],
    })
  }
  const addCustom = (): void => {
    const { model } = pick!(null)
    const name = `Agent ${form.members.length + 1}`
    patch({
      members: [
        ...form.members,
        {
          id: memberIdFor(name, taken),
          name,
          model: specOf(model),
          thinking: fitThinking(effortThinking, levelsFor(model)),
          role: '',
        },
      ],
    })
  }
  const setRole = (i: number, role: string): void => {
    const m = form.members[i]!
    // The role's preset instructions follow the role until the member's own text replaces them.
    const preset = m.instructions === undefined || m.instructions === ROLE_INSTRUCTIONS[m.role]
    const next = ROLE_INSTRUCTIONS[role.trim()]
    setMember(i, preset ? { role, instructions: next } : { role })
  }
  const setEffort = (effort: number): void => {
    const e = ROOM_EFFORTS[effort - 1]!
    patch({
      effort,
      budget: e.budget,
      members: form.members.map((m) => ({
        ...m,
        thinking: fitThinking(e.thinking, levelsOf(m.model)),
      })),
    })
  }

  const submit = async (): Promise<void> => {
    const refs = form.refs
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r !== '')
    const candidate = {
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
      template: form.template,
      members: form.members.map(({ instructions, ...m }) => ({
        ...m,
        ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      })),
      effort: form.effort,
      budget: Number(form.budget),
      ...(form.folder.trim() ? { folder: form.folder.trim() } : {}),
      refs,
      ...(form.draft !== undefined ? { draft: form.draft } : {}),
    }
    const parsed = ChatRoomSetupSchema.safeParse(candidate)
    const next: Errors = {}
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [field, index] = issue.path
        const key =
          field === 'members' && typeof index === 'number' ? `member:${index}` : String(field)
        next[key] ??=
          field === 'budget'
            ? 'A budget is a dollar amount above zero.'
            : field === 'members' && index === undefined
              ? `A room has 1 to ${ROOM_MAX_MEMBERS} members.`
              : field === 'refs'
                ? 'Up to 12 references, one per line.'
                : issue.message
      }
    } else {
      const problem = memberProblem(parsed.data.members, models)
      if (problem) next.members = problem
    }
    setErrors(next)
    setFailure(null)
    if (!parsed.success || Object.keys(next).length > 0) return
    setBusy(true)
    const refused = await onSubmit(parsed.data)
    setBusy(false)
    setFailure(refused)
  }

  const t = ROOM_TEMPLATES[form.template]
  const effort = ROOM_EFFORTS[form.effort - 1]!
  return (
    <div className="eva-room-form" data-testid="room-form">
      <div className="eva-room-form-head">
        <span className="eva-room-glyph" aria-hidden>
          <IconUsersGroup size={16} stroke={1.5} />
        </span>
        <h1 className="eva-room-form-title" data-page-title>
          {initial ? 'Edit room setup' : 'New room'}
        </h1>
        <p className="eva-room-form-sub">
          {initial
            ? 'Change who is in the room. Save to update it.'
            : 'Assemble who is in it. Nobody starts until you send the first message.'}
        </p>
      </div>
      <SegmentedControl
        fullWidth
        value={form.template}
        onChange={(v) => setForm(preset(v as RoomTemplate))}
        data={ROOM_TEMPLATE_KEYS.map((k) => ({ value: k, label: ROOM_TEMPLATES[k].label }))}
        aria-label="Template"
        data-testid="room-template"
      />
      <p className="eva-room-form-hint">{t.desc} Everything below stays editable.</p>
      <TextInput
        label="Title (optional)"
        placeholder="Auto-named from your first message"
        value={form.title}
        error={errors.title}
        onChange={(e) => patch({ title: e.currentTarget.value })}
        data-testid="room-title-input"
      />
      <div className="eva-room-form-field">
        <span className="eva-room-form-label">Members</span>
        <p className="eva-room-form-hint">Pick real assistants or add quick custom agents.</p>
        <div className="eva-room-chips">
          {assistants.map((a) => {
            const on = form.members.some((m) => m.assistant === a.id)
            return (
              <UnstyledButton
                key={a.id}
                className="eva-room-chip"
                data-on={on || undefined}
                aria-pressed={on}
                onClick={() => toggleAssistant(a)}
                data-testid={`room-chip-${a.id}`}
              >
                <img src={portrait(a.avatar)} alt="" aria-hidden draggable={false} />
                {a.title}
              </UnstyledButton>
            )
          })}
        </div>
        {errors.members ? (
          <p role="alert" className="eva-room-form-error" data-testid="room-members-error">
            {errors.members}
          </p>
        ) : null}
        {form.members.map((m, i) => {
          const levels = levelsOf(m.model)
          return (
            <div key={m.id} className="eva-room-member" data-testid={`room-member-row-${i}`}>
              <div className="eva-room-member-top">
                <MemberFace member={m} className="eva-room-member-face" />
                {m.assistant === undefined ? (
                  <TextInput
                    className="eva-room-member-name"
                    size="xs"
                    value={m.name}
                    aria-label="Name"
                    error={errors[`member:${i}`]}
                    onChange={(e) => setMember(i, { name: e.currentTarget.value })}
                    data-testid={`room-member-name-${i}`}
                  />
                ) : (
                  <b className="eva-room-member-name">{m.name}</b>
                )}
                <span className="eva-room-member-kind">
                  {m.assistant === undefined ? 'Custom' : 'Assistant'}
                </span>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`Remove ${m.name}`}
                  onClick={() => patch({ members: form.members.filter((_, j) => j !== i) })}
                  data-testid={`room-member-remove-${i}`}
                >
                  <IconX size={14} stroke={1.5} />
                </ActionIcon>
              </div>
              <div className="eva-room-member-grid">
                <TextInput
                  size="xs"
                  placeholder="Role in this room"
                  aria-label="Role"
                  value={m.role}
                  onChange={(e) => setRole(i, e.currentTarget.value)}
                  data-testid={`room-member-role-${i}`}
                />
                <RoomModelPicker
                  value={m.model}
                  models={models}
                  testid={`room-member-model-picker-${i}`}
                  onChange={(spec) =>
                    setMember(i, { model: spec, thinking: fitThinking(m.thinking, levelsOf(spec)) })
                  }
                />
                <Select
                  size="xs"
                  aria-label="Thinking"
                  allowDeselect={false}
                  value={m.thinking}
                  disabled={levels.length < 2}
                  data={levels.map((l) => ({ value: l, label: `Thinking: ${thinkingLabel(l)}` }))}
                  onChange={(v) => {
                    if (v && isLevel(v)) setMember(i, { thinking: v })
                  }}
                  data-testid={`room-member-thinking-${i}`}
                />
              </div>
              {open[m.id] ? (
                <Textarea
                  size="xs"
                  autosize
                  minRows={2}
                  maxRows={6}
                  placeholder="Instructions"
                  aria-label="Instructions"
                  value={m.instructions ?? ''}
                  onChange={(e) => setMember(i, { instructions: e.currentTarget.value })}
                  data-testid={`room-member-instructions-${i}`}
                />
              ) : (
                <UnstyledButton
                  className="eva-room-member-more"
                  onClick={() => setOpen({ ...open, [m.id]: true })}
                  data-testid={`room-member-instructions-open-${i}`}
                >
                  Instructions{m.instructions ? `: ${m.instructions}` : ''}
                </UnstyledButton>
              )}
            </div>
          )
        })}
        <Button
          variant="default"
          leftSection={<IconPlus size={14} stroke={1.5} />}
          disabled={form.members.length >= ROOM_MAX_MEMBERS}
          onClick={addCustom}
          data-testid="room-add-custom"
        >
          Add custom agent
        </Button>
      </div>
      <div className="eva-room-form-field">
        <span className="eva-room-form-label">Effort</span>
        <div className="eva-room-effort" role="radiogroup" aria-label="Effort">
          {ROOM_EFFORTS.map((e, i) => (
            <UnstyledButton
              key={e.name}
              className="eva-room-effort-dot"
              role="radio"
              aria-checked={form.effort === i + 1}
              aria-label={e.name}
              data-on={i < form.effort || undefined}
              onClick={() => setEffort(i + 1)}
              data-testid={`room-effort-${i + 1}`}
            />
          ))}
          <span className="eva-room-form-hint">
            {effort.name} · thinking {thinkingLabel(effort.thinking)} for everyone
          </span>
        </div>
      </div>
      <NumberInput
        label="Budget cap"
        description="The room pauses itself here."
        prefix="$"
        min={0}
        decimalScale={2}
        w={160}
        value={form.budget}
        error={errors.budget}
        onChange={(v) => patch({ budget: v })}
        data-testid="room-budget"
      />
      <TextInput
        label="Source folder (optional)"
        description="Copied into the room's workdir. The original is never edited."
        placeholder="work/blender-learning/cel-face"
        value={form.folder}
        error={errors.folder}
        onChange={(e) => patch({ folder: e.currentTarget.value })}
        data-testid="room-folder"
      />
      <Textarea
        label="References (optional)"
        description="Full paths or URLs, one per line."
        autosize
        minRows={2}
        value={form.refs}
        error={errors.refs}
        onChange={(e) => patch({ refs: e.currentTarget.value })}
        data-testid="room-refs"
      />
      {failure ? (
        <Alert color="red" data-testid="room-form-error">
          {failure}
        </Alert>
      ) : null}
      <div className="eva-room-form-actions">
        <Button loading={busy} onClick={() => void submit()} data-testid="room-submit">
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="default" onClick={onCancel} data-testid="room-cancel">
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  )
}
