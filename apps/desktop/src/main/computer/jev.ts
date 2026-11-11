import * as fs from 'node:fs'
import * as path from 'node:path'

/** Jev (TypeSafe System One): fast calibrated answers; @computer's judge asks it. */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

/** `TYPESAFE_API_KEY` from the environment, else `<evaRoot>/secrets/jev.env`; null when neither has it. */
export function readJevKey(evaRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.TYPESAFE_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const m = /^TYPESAFE_API_KEY=(.+)$/m.exec(
      fs.readFileSync(path.join(evaRoot, 'secrets', 'jev.env'), 'utf8'),
    )
    return m?.[1]?.trim() || null
  } catch {
    return null
  }
}
