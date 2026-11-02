import { Text } from '@mantine/core'
import { useMemo } from 'react'
import { qrSvg } from './qr'

/** A scannable QR for `value`, with its caption underneath. */
export function QrCode({
  value,
  caption,
  testid,
}: {
  value: string
  caption: string
  testid: string
}) {
  const src = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg(value))}`, [value])
  return (
    <div className="eva-setup-qr" data-testid={testid}>
      <img src={src} alt={`QR code for ${caption}`} width={160} height={160} />
      <Text size="sm" fw={600}>
        {caption}
      </Text>
    </div>
  )
}
