import { memo } from 'react'
import { useColorScheme } from '../theme/theme-config'
import { iconUrl, type IconQuery } from './file-icons'

/** A Material Icon Theme icon for a file or folder name, sized for a tree row. */
export const FileIcon = memo(function FileIcon(
  props: Omit<IconQuery, 'light'> & { size?: number },
) {
  const light = useColorScheme() === 'light'
  const { size = 16, ...q } = props
  return (
    <img
      className="eva-files-icon"
      src={iconUrl({ ...q, light })}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  )
})
