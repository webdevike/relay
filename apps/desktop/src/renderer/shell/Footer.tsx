import { Button, Tooltip } from '@mantine/core'
import { IconHelp } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'

export function Footer() {
  return (
    <footer className="eva-footer" data-testid="footer">
      <Tooltip label="Help Center">
        <Button
          variant="subtle"
          size="compact-sm"
          className="eva-footer-help"
          data-testid="footer-help"
          leftSection={<IconHelp size={16} />}
          onClick={() => openPlace(placeOf('help'))}
        >
          <span className="eva-label">Help</span>
        </Button>
      </Tooltip>
      <div className="eva-footer-eregon" data-testid="footer-eregon-slot" />
    </footer>
  )
}
