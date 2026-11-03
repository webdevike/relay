import { Anchor, Stack, Table, Text } from '@mantine/core'
import { IconBrandGithub } from '@tabler/icons-react'
import type { TableCell, TableCellIcon, TableSpec } from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { WidgetTitle } from '../rich/parts'
import { useToneText } from './content'

/** Linear's mark (Simple Icons, CC0); Tabler has no Linear brand icon. */
export function LinearMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="Linear">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

function CellIcon({ icon }: { icon: TableCellIcon }) {
  return icon === 'github' ? (
    <IconBrandGithub size={14} stroke={1.75} aria-label="GitHub" />
  ) : (
    <LinearMark size={13} />
  )
}

function Cell({ cell }: { cell: TableCell }) {
  const toneText = useToneText()
  if (typeof cell !== 'object') return <>{String(cell)}</>
  const content = (
    <span className="eva-wb-cell">
      {cell.icon !== undefined ? <CellIcon icon={cell.icon} /> : null}
      {cell.text !== '' ? <span>{cell.text}</span> : null}
    </span>
  )
  const style = { color: toneText(cell.tone), fontWeight: cell.bold ? 600 : undefined }
  if (cell.url === undefined) return <span style={style}>{content}</span>
  const url = cell.url
  return (
    <Anchor
      href={url}
      title={url}
      inherit
      style={{ fontWeight: style.fontWeight }}
      onClick={(e) => {
        e.preventDefault()
        openLink(url, { newPane: e.metaKey })
      }}
    >
      {content}
    </Anchor>
  )
}

/** A data table that scrolls sideways when wider than the column. */
export function TableBlock({ spec }: { spec: TableSpec }) {
  const aligns = spec.columns.map((column) =>
    typeof column === 'string' ? undefined : column.align,
  )
  return (
    <Stack gap={6} className="eva-wb-table" data-testid="widget-table">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div className="eva-wb-table-scroll">
        <Table fz="sm" verticalSpacing={6} horizontalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              {spec.columns.map((column, i) => (
                <Table.Th key={i} ta={aligns[i]}>
                  <Text size="xs" c="dimmed" fw={500} span>
                    {typeof column === 'string' ? column : column.label}
                  </Text>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {spec.rows.map((row, r) => (
              <Table.Tr key={r}>
                {row.map((cell, c) => (
                  <Table.Td key={c} ta={aligns[c]}>
                    <Cell cell={cell} />
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  )
}
