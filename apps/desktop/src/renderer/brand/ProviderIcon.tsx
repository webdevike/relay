import { IconBrandOpenai } from '@tabler/icons-react'
import type { UsageProvider } from '@evaos/contract'

/** Anthropic "A\" mark, drawn in currentColor. */
export function IconAnthropic({
  size = 14,
  ...rest
}: { size?: number } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
      <path d="M13.83 3h3.53L24 21h-3.53L13.83 3ZM6.62 3h3.69L16.95 21h-3.71l-1.36-3.78H4.93L3.57 21H0L6.62 3Zm4.13 11.11L8.47 7.78l-2.28 6.33h4.56Z" />
    </svg>
  )
}

const LABEL: Record<UsageProvider, string> = { anthropic: 'Claude', 'openai-codex': 'Codex' }

/** Brand mark for a model provider; labelled for screen readers. */
export function ProviderIcon({ provider, size = 14 }: { provider: UsageProvider; size?: number }) {
  const label = LABEL[provider]
  const a11y = { role: 'img', 'aria-label': label }
  return (
    <span className="eva-provider-icon" {...a11y} title={label} style={{ display: 'inline-flex' }}>
      {provider === 'anthropic' ? (
        <IconAnthropic size={size} aria-hidden />
      ) : (
        <IconBrandOpenai size={size} stroke={1.5} aria-hidden />
      )}
    </span>
  )
}
