import { useState } from 'react'
import { Loader } from '@mantine/core'
import {
  IconChevronRight,
  IconFile,
  IconSearch,
  IconTerminal2,
  IconTool,
  IconWorld,
} from '@tabler/icons-react'
import type { ChatMessage } from '@evaos/chat-core/message'

/** Lines of a tool's input, and of its output, shown before "… N more lines" (chat_view.rs). */
const INPUT_LINES = 30
const OUTPUT_LINES = 16

/** `text`'s first `max` lines, with a line counting the rest. */
export function clipLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines`
}

/** Icons by tool name, lowercased: Claude Code capitalizes its tool names (Bash, Read, WebFetch). */
const ICON_BY_TOOL: Record<string, typeof IconTool> = {
  bash: IconTerminal2,
  eval: IconTerminal2,
  read: IconFile,
  write: IconFile,
  edit: IconFile,
  grep: IconSearch,
  glob: IconSearch,
  find: IconSearch,
  web_search: IconWorld,
  websearch: IconWorld,
  browse: IconWorld,
  fetch: IconWorld,
  webfetch: IconWorld,
}

function ToolIcon({ name }: { name: string }) {
  const Icon = ICON_BY_TOOL[name.toLowerCase()] ?? IconTool
  return <Icon size={13} stroke={1.75} className="eva-tool-icon" aria-hidden />
}

/**
 * A tool call in the verbose view (chat_view.rs ToolBlock): a header with the tool's icon, name,
 * intent and "failed" when it errored, then its input and its quieter output as code, clipped.
 */
export function ToolBlock({ m, images }: { m: ChatMessage; images: React.ReactNode }) {
  const io = m.tool
  const input = io?.input.trimEnd() ?? ''
  const output = io?.result?.trimEnd() ?? ''
  const failed = io?.status === 'failed' || io?.isError === true
  return (
    <div className="eva-tool" data-testid="tool-block">
      <div className="eva-tool-head">
        <ToolIcon name={m.text} />
        <span className="eva-tool-name">{m.text}</span>
        {m.detail ? <span className="eva-tool-detail">{m.detail}</span> : null}
        {io?.status === 'running' ? (
          <Loader size={10} color="var(--eva-text-dim)" aria-label="Running" />
        ) : null}
        {failed ? <span className="eva-tool-failed">failed</span> : null}
      </div>
      {input.trim() !== '' ? (
        <pre className="eva-tool-code">{clipLines(input, INPUT_LINES)}</pre>
      ) : null}
      {output.trim() !== '' && !(m.images.length > 0 && output.startsWith('Read image file')) ? (
        <pre className="eva-tool-code eva-tool-output">{clipLines(output, OUTPUT_LINES)}</pre>
      ) : null}
      {images}
    </div>
  )
}

/** "Used 3 tools · read, edit": a run of calls folded to one line until clicked (tool_group). */
export function groupLabel(tools: ChatMessage[]): string {
  if (tools.length === 1) {
    const t = tools[0]!
    return t.detail ? `${t.text} · ${t.detail}` : `Used ${t.text}`
  }
  const names = [...new Set(tools.map((t) => t.text))]
  return `Used ${tools.length} tools · ${names.join(', ')}`
}

export function ToolGroup({
  tools,
  images,
}: {
  tools: ChatMessage[]
  images: (m: ChatMessage) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const many = tools.length > 1
  const failed = tools.some((t) => t.tool?.status === 'failed' || t.tool?.isError)
  const running = tools.some((t) => t.tool?.status === 'running')
  const head = (
    <>
      <IconTool size={13} stroke={1.75} className="eva-tool-icon" aria-hidden />
      <span className="eva-tool-summary">{groupLabel(tools)}</span>
      {running ? <Loader size={10} color="var(--eva-text-dim)" aria-label="Running" /> : null}
      {failed ? <span className="eva-tool-failed">failed</span> : null}
      {many ? (
        <IconChevronRight
          size={13}
          stroke={1.75}
          className="eva-chevron"
          data-open={open}
          aria-hidden
        />
      ) : null}
    </>
  )
  return (
    <div className="eva-tool-group" data-testid="tool-group">
      {many ? (
        <button
          type="button"
          className="eva-tool-head eva-tool-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {head}
        </button>
      ) : (
        <div className="eva-tool-head">{head}</div>
      )}
      {open && many ? (
        <div className="eva-tool-lines">
          {tools.map((t) => (
            <div key={t.id} className="eva-tool-line">
              <span className="eva-tool-line-name">{t.text}</span>
              <span className="eva-tool-detail">{t.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
      {/* Images the tools read (screenshots) show even while the run is folded. */}
      {tools.map((t) => (t.images.length > 0 ? <div key={t.id}>{images(t)}</div> : null))}
    </div>
  )
}
