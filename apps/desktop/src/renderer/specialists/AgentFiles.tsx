import { useEffect } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconCircleCheck, IconGitCommit, IconX } from '@tabler/icons-react'
import { EditorArea } from '../files/EditorArea'
import { FileIcon } from '../files/FileIcon'
import { FileTree } from '../files/FileTree'
import { clearError, startFiles, useSpace } from '../files/files-store'
import { ListEmpty } from '../ui/list'
import { useSpecialists } from './specialists-store'
import { savedTone } from './specialists-view'
import '../files/files.css'

/**
 * One agent's files in the Files tab's own tree and editor, rooted at its folder in the installed
 * service (a spec agent's tree shows only its own files). Cmd+S saves into that copy, which the
 * service loads within a second; main then commits the save to the repo, and the line over the
 * editor says how that went.
 */
export function AgentFiles({ agent }: { agent: string }) {
  const folder = useSpecialists((s) => s.folders[agent] ?? null)
  const saved = useSpecialists((s) => s.saved[agent] ?? null)
  const root = folder !== null && 'root' in folder ? folder.root : null
  const error = useSpace(root, (w) => w.error, null)
  useEffect(() => startFiles(), [])

  if (folder === null) return <div className="eva-ab-loading">Opening the agent's files</div>
  if ('error' in folder)
    return (
      <ListEmpty role="alert" data-testid="agent-files-error" title="Could not open the files">
        {folder.error}
      </ListEmpty>
    )

  const tone = saved === null ? null : savedTone(saved)
  return (
    <div className="eva-files eva-sp-files" data-testid="agent-files">
      <aside className="eva-files-side eva-sp-files-side">
        <div className="eva-files-side-head">
          <Tooltip label={folder.root} openDelay={600}>
            <span className="eva-files-root" data-testid="agent-files-root">
              <FileIcon name={folder.name} kind="dir" expanded />
              <span className="eva-files-name">{folder.name}</span>
            </span>
          </Tooltip>
        </div>
        <FileTree root={folder.root} only={folder.only} />
      </aside>
      <main className="eva-files-main">
        <div
          className="eva-sp-files-status"
          data-tone={tone ?? undefined}
          data-testid="agent-files-status"
          role={tone === 'bad' ? 'alert' : undefined}
        >
          {saved === null ? (
            <IconGitCommit size={14} stroke={1.5} aria-hidden />
          ) : tone === 'ok' ? (
            <IconCircleCheck size={14} stroke={1.5} aria-hidden />
          ) : (
            <IconAlertTriangle size={14} stroke={1.5} aria-hidden />
          )}
          <span className="eva-sp-files-statustext" title={saved?.detail}>
            {saved !== null
              ? `${saved.path}: ${saved.detail}`
              : folder.repo === null
                ? 'Saves go live at once.'
                : 'Saves go live at once and are committed to main.'}
          </span>
        </div>
        {error ? (
          <div className="eva-files-error" role="alert">
            <span>{error}</span>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Dismiss"
              onClick={() => clearError(folder.root)}
            >
              <IconX size={14} stroke={1.5} />
            </ActionIcon>
          </div>
        ) : null}
        <EditorArea root={folder.root} empty={<p>Open a file from the tree on the left.</p>} />
      </main>
    </div>
  )
}
