import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeInput,
  InvokeOutput,
  Result,
} from '@evaos/contract'

export function invoke<K extends InvokeChannel>(
  channel: K,
  input: InvokeInput<K>,
): Promise<Result<InvokeOutput<K>>> {
  return window.eva.invoke(channel, input)
}

export function on<K extends EventChannel>(
  channel: K,
  cb: (payload: EventPayload<K>) => void,
): () => void {
  return window.eva.on(channel, cb)
}
