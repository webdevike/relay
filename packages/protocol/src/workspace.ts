// ---------------------------------------------------------------------------------------------
// The window mirror: what every Relay Desktop shows (app tabs and the one in front, each
// workspace's panes, pinned tool tabs, web pages and their URLs) is one set of entries the host
// keeps, so the Mini and the MacBook show the same thing live. Each entry is a key and a JSON value
// the desktops define (`tabs`, `layout:<workspace>`, `page:<tab id>`, ...); the host merges per key,
// last writer wins, and never reads the values. Window bounds and OS focus stay on each Mac.
//
// A desktop sends `workspace.get` once connected (it then gets every change) and answers the
// snapshot: when the host has nothing yet it seeds it (`seed`), else it adopts the host's. Its own
// changes go up as `workspace.put` (the keys it set and deleted, tagged with its `origin`, an id
// per app launch) and come back as `workspace.ack` with the new rev; every other subscribed socket
// gets them as `workspace.changed`. Phones never subscribe. Only sent to a host whose
// `welcome.features` has WORKSPACE_FEATURE.
// ---------------------------------------------------------------------------------------------

import { z } from "zod";

export const WORKSPACE_FEATURE = "workspace";

/** All entries together, serialized, at most this many bytes; a put that would pass it is refused. */
export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;

export const WorkspaceKey = z.string().min(1).max(600);
export type WorkspaceKey = z.infer<typeof WorkspaceKey>;

/** Values by key; a value is any JSON but null (a deleted key is in `del`). */
export const WorkspaceEntries = z.record(WorkspaceKey, z.unknown());
export type WorkspaceEntries = z.infer<typeof WorkspaceEntries>;

/** Who wrote a change: one id per app launch, so a desktop knows its own changes. */
export const WorkspaceOrigin = z.string().min(1).max(200);

export const WorkspaceRid = z.string().min(1).max(64);

/** Frames a desktop sends. */
export const WorkspaceClientFrames = [
  /** Subscribe: answered by `workspace.state`, then every change by others as `workspace.changed`. */
  z.object({ t: z.literal("workspace.get") }),
  /**
   * Set and delete keys. `seed`: only applied when the host holds nothing yet (else the host answers
   * `workspace.state` again so the desktop adopts it). Answered by `workspace.ack`.
   */
  z.object({
    t: z.literal("workspace.put"),
    rid: WorkspaceRid,
    origin: WorkspaceOrigin,
    set: WorkspaceEntries,
    del: z.array(WorkspaceKey).max(10_000),
    seed: z.boolean().optional(),
  }),
] as const;

/** Frames the host sends (only to sockets that sent `workspace.get`). */
export const WorkspaceServerFrames = [
  /** Every entry and the rev they are at (0: the host holds nothing yet). */
  z.object({
    t: z.literal("workspace.state"),
    rev: z.number().int().nonnegative(),
    entries: WorkspaceEntries,
  }),
  /** Another desktop's put, as merged: the rev it made. */
  z.object({
    t: z.literal("workspace.changed"),
    rev: z.number().int().nonnegative(),
    origin: WorkspaceOrigin,
    set: WorkspaceEntries,
    del: z.array(WorkspaceKey).max(10_000),
  }),
  /**
   * The answer to `workspace.put` with the same rid: `rev` the host is at after it. `applied` false:
   * a seed the host refused (it holds entries already) or a put over MAX_WORKSPACE_BYTES.
   */
  z.object({
    t: z.literal("workspace.ack"),
    rid: WorkspaceRid,
    rev: z.number().int().nonnegative(),
    applied: z.boolean(),
  }),
] as const;
