/// <reference types="vite/client" />
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeInput,
  InvokeOutput,
  Result,
} from '@evaos/contract'

declare global {
  const __RELAY_BUILD__: string
  /** When this build was made, ISO 8601. */
  const __RELAY_BUILT_AT__: string
}

declare global {
  interface Window {
    eva: {
      invoke<K extends InvokeChannel>(
        channel: K,
        input: InvokeInput<K>,
      ): Promise<Result<InvokeOutput<K>>>
      on<K extends EventChannel>(channel: K, cb: (payload: EventPayload<K>) => void): () => void
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        partition?: string
        alignment?: string
        tab?: string
      }
    }
  }
}
