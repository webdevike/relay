import { z } from 'zod'

/** Longest username or password, in UTF-16 code units (the relay protocol's `MAX_SIGNIN_FIELD`). */
export const MAX_SIGNIN_FIELD = 1024

export const signinInvoke = {
  /**
   * Isaac's credentials for the login page `url` that reply `messageId` of assistant `agent`'s
   * thread asked him to sign in to (its `[[signin:<url>]]` card). The host types them into that
   * page in Eva's contained browser and tells the agent; resolves once it has. Fails with the
   * host's reason (the page's own error, such as a wrong password) or `not_connected`.
   */
  'signin.submit': {
    input: z
      .object({
        agent: z.string().min(1).max(128),
        messageId: z.string().min(1).max(256),
        url: z.string().url().max(2048),
        username: z.string().max(MAX_SIGNIN_FIELD),
        password: z.string().min(1).max(MAX_SIGNIN_FIELD),
      })
      .strict(),
    output: z.object({}),
  },
} as const
