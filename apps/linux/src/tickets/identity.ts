// Who the host acts as (PLAN §2.8): the Linear viewer behind the host's own key and gh's login,
// resolved at the start of every sync cycle. The host never falls back to another key or login: a
// revoked key resolves to no Linear identity, which counts as a change (wipe, refuse writes).

import type { TicketsStatus } from "@relay/protocol";
import { z } from "zod";
import { LinearUnauthorized, type LinearGql } from "../reviews/linear";
import { publicError } from "./errors";

export type HostIdentity = TicketsStatus["identity"];

export const NO_IDENTITY: HostIdentity = { linear: null, github: null };

const Viewer = z.object({
  viewer: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().optional(),
    email: z.string(),
    url: z.string().optional(),
    organization: z.object({ name: z.string() }),
  }),
});

/** The viewer plus what attention matches mentions with (display name, profile url). */
export interface ResolvedIdentity {
  readonly identity: HostIdentity;
  /** Names a Linear comment mentions Isaac by: name, display name, profile url. */
  readonly linearNames: readonly string[];
  readonly errors: { readonly linear: string | null; readonly github: string | null };
}

const VIEWER_QUERY = `{ viewer { id name displayName email url organization { name } } }`;

/** The Linear viewer, null when Linear does not take the key; other failures throw (try again later). */
async function linearViewer(gql: LinearGql): Promise<{ id: HostIdentity["linear"]; names: string[]; error: string | null }> {
  try {
    const { viewer: v } = Viewer.parse(await gql(VIEWER_QUERY));
    const names = [v.name, v.displayName, v.url].filter((n): n is string => n !== undefined && n !== "");
    return { id: { viewerId: v.id, name: v.name, email: v.email, org: v.organization.name }, names, error: null };
  } catch (error) {
    if (error instanceof LinearUnauthorized) return { id: null, names: [], error: publicError(error, "Linear") };
    throw error;
  }
}

/**
 * Both accounts. `ghLogin` resolves null when gh is signed out (a change); a gh failure keeps the
 * previous login and reports the error, so a flaky gh never wipes the board.
 */
export async function resolveIdentity(gql: LinearGql, ghLogin: () => Promise<string | null>, prev: HostIdentity | null): Promise<ResolvedIdentity> {
  const linear = await linearViewer(gql);
  let github: HostIdentity["github"] = null;
  let ghError: string | null = null;
  try {
    const login = await ghLogin();
    github = login === null ? null : { login };
    if (login === null) ghError = "gh is not signed in on the host";
  } catch (error) {
    github = prev?.github ?? null;
    ghError = publicError(error, "GitHub");
  }
  return { identity: { linear: linear.id, github }, linearNames: linear.names, errors: { linear: linear.error, github: ghError } };
}

/** Whether `next` acts as someone else than `prev` (a first resolution is no change). */
export function identityChanged(prev: HostIdentity | null, next: HostIdentity): boolean {
  if (prev === null) return false;
  return prev.linear?.viewerId !== next.linear?.viewerId || prev.github?.login !== next.github?.login;
}
