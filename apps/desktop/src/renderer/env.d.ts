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
