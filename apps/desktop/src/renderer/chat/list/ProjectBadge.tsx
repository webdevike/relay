import eva from '../../assets/projects/eva.png'
import ecard from '../../assets/projects/ecard.png'
import goodops from '../../assets/projects/goodops.png'
import relay from '../../assets/projects/relay.png'
import { projectColor, projectInitials } from './look'

/** Workspaces with an icon (native PROJECT_ICONS); EvaOS shares Eva's. */
const ICONS: Record<string, string> = {
  Eva: eva,
  EvaOS: eva,
  eCard: ecard,
  GoodOps: goodops,
  Relay: relay,
}

/**
 * A workspace's badge: its project icon, else its two letters in white on a chart color picked by
 * its name, darkened so the letters keep 4.5:1. `md` sits in a folder header, `sm` inline on a row.
 */
export function ProjectBadge({ name, size }: { name: string; size: 'sm' | 'md' }) {
  const icon = Object.hasOwn(ICONS, name) ? ICONS[name] : undefined
  if (icon !== undefined) {
    return <img className="eva-cl-badge-img" data-size={size} src={icon} alt="" aria-hidden />
  }
  return (
    <span
      className="eva-cl-badge-tile"
      data-size={size}
      aria-hidden
      style={{
        background: `color-mix(in srgb, var(--eva-chart-${projectColor(name) + 1}) 55%, black)`,
      }}
    >
      {projectInitials(name)}
    </span>
  )
}
