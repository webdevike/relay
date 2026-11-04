import { Select } from '@mantine/core'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { IconGripVertical } from '@tabler/icons-react'
import { EvaModal } from '../overlay'
import { navIcon } from './icons'
import './customize.css'
import {
  BADGE_LABEL,
  VISIBILITY_LABEL,
  moveId,
  sectionKey,
  sidebarPrefsStore,
  useSidebarPrefs,
  type BadgeStyle,
  type SectionId,
  type Visibility,
} from './sidebar-prefs'

export interface CustomizeItem {
  id: string
  title: string
  icon: string
}
/** A section as drawn now: its rows in the user's order, hidden ones included. */
export interface CustomizeSection {
  id: SectionId
  title: string
  items: readonly CustomizeItem[]
}

const VISIBILITY_DATA = (Object.keys(VISIBILITY_LABEL) as Visibility[]).map((value) => ({
  value,
  label: VISIBILITY_LABEL[value],
}))
const BADGE_DATA = (Object.keys(BADGE_LABEL) as BadgeStyle[]).map((value) => ({
  value,
  label: BADGE_LABEL[value],
}))

// Above the modal (zIndex 300), which would otherwise cover the dropdowns.
const COMBOBOX = { withinPortal: true, zIndex: 400 } as const

function VisibilitySelect({ id, label }: { id: string; label: string }) {
  const value = useSidebarPrefs((s) => s.visibility[id] ?? 'always')
  return (
    <Select
      className="eva-sb-cz-select"
      size="xs"
      aria-label={label}
      data-testid={`cz-visibility-${id}`}
      data={VISIBILITY_DATA}
      value={value}
      allowDeselect={false}
      comboboxProps={COMBOBOX}
      onChange={(v) => {
        if (v) sidebarPrefsStore.getState().setVisibility(id, v as Visibility)
      }}
    />
  )
}

function Row({ item }: { item: CustomizeItem }) {
  const hidden = useSidebarPrefs((s) => s.visibility[item.id] === 'never')
  const drag = useDraggable({ id: item.id })
  const drop = useDroppable({ id: item.id })
  const Glyph = navIcon(item.icon)
  const t = drag.transform
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el)
        drop.setNodeRef(el)
      }}
      className="eva-sb-cz-row"
      data-testid={`cz-row-${item.id}`}
      data-hidden={hidden ? 'true' : undefined}
      data-dragging={drag.isDragging ? 'true' : undefined}
      data-over={drop.isOver && !drag.isDragging ? 'true' : undefined}
      style={t ? { transform: `translate3d(${t.x}px, ${t.y}px, 0)` } : undefined}
    >
      <button
        type="button"
        className="eva-sb-cz-grip"
        aria-label={`Reorder ${item.title}`}
        data-testid={`cz-grip-${item.id}`}
        {...drag.attributes}
        {...drag.listeners}
      >
        <IconGripVertical size={14} stroke={1.5} aria-hidden />
      </button>
      <Glyph size={16} aria-hidden className="eva-sb-cz-icon" />
      <span className="eva-sb-cz-label">{item.title}</span>
      <VisibilitySelect id={item.id} label={`${item.title} visibility`} />
    </div>
  )
}

function Group({ section }: { section: CustomizeSection }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    sidebarPrefsStore.getState().setOrder(
      section.id,
      moveId(
        section.items.map((i) => i.id),
        String(active.id),
        String(over.id),
      ),
    )
  }
  return (
    <section className="eva-sb-cz-group" data-testid={`cz-group-${section.id}`}>
      <div className="eva-sb-cz-ghead">
        <span className="eva-sb-cz-gtitle">{section.title}</span>
        <VisibilitySelect
          id={sectionKey(section.id)}
          label={`${section.title} section visibility`}
        />
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {section.items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </DndContext>
    </section>
  )
}

/** The Customize sidebar dialog: every section as one bordered group, changes applied live. */
export function CustomizeSidebarModal({
  sections,
  opened,
  onClose,
}: {
  sections: readonly CustomizeSection[]
  opened: boolean
  onClose: () => void
}) {
  const badge = useSidebarPrefs((s) => s.badgeStyle)
  return (
    <EvaModal
      opened={opened}
      onClose={onClose}
      title="Customize sidebar"
      size={560}
      testid="customize-sidebar"
    >
      <div className="eva-sb-cz">
        <div className="eva-sb-cz-top">
          <span className="eva-sb-cz-label">Default badge style</span>
          <Select
            className="eva-sb-cz-select"
            size="xs"
            aria-label="Default badge style"
            data-testid="cz-badge-style"
            data={BADGE_DATA}
            value={badge}
            allowDeselect={false}
            comboboxProps={COMBOBOX}
            onChange={(v) => {
              if (v) sidebarPrefsStore.getState().setBadgeStyle(v as BadgeStyle)
            }}
          />
        </div>
        {sections.map((s) => (
          <Group key={s.id} section={s} />
        ))}
      </div>
    </EvaModal>
  )
}
