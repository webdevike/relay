export type Result<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const err = (code: string, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
})
