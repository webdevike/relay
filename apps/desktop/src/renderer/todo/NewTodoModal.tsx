import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Kbd, Select, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAlertCircle } from '@tabler/icons-react'
import { EvaModal } from '../overlay'
import { invoke } from '../ipc'
import { reloadAll } from '../reload/reload'
import { loadDashboard, useDashboard } from '../dashboard/dashboard-store'
import { closeNewTodo, finishNewTodo, newTodoStore, useNewTodo } from './new-todo-store'
import './new-todo.css'

const MAX = 2000
const ERROR_COPY =
  'Could not add the todo. memory/todos.md changed while you were typing or could not be written. Review the preview and try again.'

const collapse = (t: string): string => t.replace(/\s*[\r\n]+\s*/g, ' ').trim()

function Form() {
  const workspaces = useDashboard((s) => s.data?.workspaces)
  const [tag, setTag] = useState(() => newTodoStore.getState().tag)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [preview, setPreview] = useState<{ nextId: string; today: string } | null>(null)

  const options = useMemo(() => {
    const list = (workspaces ?? []).map((w) => ({ value: w.id, label: w.displayName }))
    if (!list.some((o) => o.value === 'eva')) list.unshift({ value: 'eva', label: 'Eva' })
    if (!list.some((o) => o.value === tag)) list.push({ value: tag, label: tag })
    return list
  }, [workspaces, tag])

  const fetchPreview = useCallback(async () => {
    const r = await invoke('eva.todo.preview', {})
    if (r.ok) setPreview(r.value)
  }, [])

  useEffect(() => {
    void fetchPreview()
    if (!workspaces) void loadDashboard()
    // once per open
  }, [])

  const clean = collapse(text)
  const hadBreaks = /[\r\n]/.test(text)
  const line =
    preview && clean ? `${preview.nextId} [${tag}] ${clean} (added ${preview.today})` : ''

  const submit = async (): Promise<void> => {
    if (!clean || pending) return
    setPending(true)
    setError(false)
    let ok = false
    let id = ''
    try {
      const r = await invoke('eva.todo.add', { tag, text: clean })
      ok = r.ok
      if (r.ok) id = r.value.id
    } catch {
      ok = false
    }
    setPending(false)
    if (!ok) {
      setError(true)
      void fetchPreview()
      return
    }
    const name = options.find((o) => o.value === tag)?.label ?? tag
    finishNewTodo(tag)
    notifications.show({
      message: `Added ${id} to ${name}.`,
      color: 'green',
      autoClose: 4000,
    })
    void reloadAll()
  }

  return (
    <div className="eva-new-todo">
      <Select
        label="Workspace"
        data={options}
        value={tag}
        onChange={(v) => v && setTag(v)}
        searchable
        allowDeselect={false}
        comboboxProps={{ zIndex: 400 }}
        data-testid="new-todo-workspace"
      />
      <div>
        <Textarea
          label="Todo"
          placeholder="What needs doing"
          required
          autosize
          minRows={2}
          maxRows={5}
          maxLength={MAX}
          value={text}
          data-autofocus
          data-testid="new-todo-text"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {hadBreaks ? <div className="eva-new-todo-hint">Line breaks become spaces.</div> : null}
      </div>
      <div className="eva-new-todo-preview" data-testid="new-todo-preview">
        {line}
      </div>
      {error ? (
        <div className="eva-new-todo-error" role="alert">
          <IconAlertCircle size={16} aria-hidden="true" />
          <span>{ERROR_COPY}</span>
        </div>
      ) : null}
      <div className="eva-new-todo-footer">
        <Button variant="default" onClick={closeNewTodo} data-testid="new-todo-discard">
          Discard todo
        </Button>
        <Button
          disabled={!clean}
          onClick={() => void submit()}
          data-testid="new-todo-submit"
          rightSection={pending ? null : <Kbd style={{ opacity: 0.7 }}>⌘↵</Kbd>}
        >
          {pending ? 'Adding' : 'Add todo'}
        </Button>
      </div>
    </div>
  )
}

export function NewTodoModal() {
  const opened = useNewTodo((s) => s.opened)
  return (
    <EvaModal
      opened={opened}
      onClose={closeNewTodo}
      title="New Todo"
      size={480}
      testid="new-todo-modal"
    >
      <Form />
    </EvaModal>
  )
}
