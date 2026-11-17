import { Effect, Schema } from "effect";
import { homedir } from "node:os";
import { inflateSync } from "node:zlib";
import { APP, type Run, SoundlyError } from "./run.ts";

/**
 * The cloud API Soundly's desktop app speaks (research: `work/soundly-agent/RESEARCH.md` in Eva). Form fields POSTed
 * to its Cloud Run server (semantic search on its own host), JSON back, no signing. The constants (server, the
 * app-wide `server_token`, this install's `ClientID`) are read from the installed app by `app_constants.py` under the
 * app's own interpreter, once per app build. Sign-in uses the login the app saved (`SavedUser` in its prefs: email and
 * the salted hash the app itself sends), so it needs nothing from Isaac and never sees a password. Neither the login
 * nor the session id is ever logged, returned or written anywhere: they live in this process's memory only.
 */

const RESOURCES = `${APP}/Contents/Resources`;
export const PREFS = `${homedir()}/Library/Preferences/com.soundly.Soundly.plist`;

/** Keys `cloudServer.__formatData__` sends: strings as they are, other values as JSON, `None` left out. */
export const encodeForm = (fields: Readonly<Record<string, unknown>>): string =>
  new URLSearchParams(
    Object.entries(fields).flatMap(([key, value]) =>
      value === undefined || value === null
        ? []
        : [[key, typeof value === "string" ? value : JSON.stringify(value)]],
    ),
  ).toString();

type Reply = ReadonlyArray<Readonly<Record<string, unknown>>>;

/** Soundly answers a JSON list of one-key objects (or base64 zlib JSON when it zips): always a list of objects. */
export const decodeReply = (text: string): Reply => {
  const body = text.trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    value = JSON.parse(inflateSync(Buffer.from(body, "base64")).toString("utf8"));
  }
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
};

/** The first value under `key` in a reply. */
export const field = (items: Reply, key: string) => items.find((item) => key in item)?.[key];

export interface Match {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly seconds: number;
  readonly libraryId: string;
}

export interface Collection {
  readonly key: string;
  readonly name: string;
  /** `Admin` on the account's own collections, `Read` on Soundly's curated ones. */
  readonly permissions: string;
}

export interface Library {
  readonly id: string;
  readonly name: string;
}

const rows = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    : [];

/** `SearchMatches` entries, the duplicates Soundly sometimes repeats dropped. */
export const toMatches = (value: unknown): ReadonlyArray<Match> => {
  const seen = new Set<string>();
  return rows(value).flatMap((row): ReadonlyArray<Match> => {
    const id = String(row["FileID"] ?? "");
    if (id === "" || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: String(row["Name"] ?? ""),
        description: String(row["Description"] ?? ""),
        seconds: Number(row["Length"] ?? 0) || 0,
        libraryId: String(row["LibraryID"] ?? ""),
      },
    ];
  });
};

export const toCollections = (value: unknown): ReadonlyArray<Collection> =>
  rows(value).flatMap((row): ReadonlyArray<Collection> => {
    const key = row["Key"];
    const name = row["Name"];
    return typeof key === "string" && typeof name === "string"
      ? [{ key, name, permissions: String(row["Permissions"] ?? "") }]
      : [];
  });

/** What one signed-in session can do. */
export interface SoundlyApi {
  /** The cloud libraries the account can search (the Free plan: Soundly Free). */
  readonly libraries: ReadonlyArray<Library>;
  /** Semantic search (Soundly's HybridSearch), else its keyword search when that fails. */
  search(
    query: string,
    pageSize: number,
  ): Effect.Effect<
    { readonly mode: "semantic" | "keyword"; readonly matches: ReadonlyArray<Match> },
    SoundlyError
  >;
  /** Top-level collections: Soundly's curated folder (Read) and the account's own (Admin). */
  readonly collections: Effect.Effect<ReadonlyArray<Collection>, SoundlyError>;
  /** A new top-level collection under My Collections. */
  create(name: string): Effect.Effect<Collection, SoundlyError>;
  add(key: string, sounds: ReadonlyArray<Match>): Effect.Effect<void, SoundlyError>;
  /** The file ids in a collection, as Soundly lists them. */
  fileIds(key: string): Effect.Effect<ReadonlyArray<string>, SoundlyError>;
  /** Deletes a collection and checks it is gone. */
  remove(key: string): Effect.Effect<void, SoundlyError>;
}

const Constants = Schema.Struct({
  server: Schema.NonEmptyString,
  semanticServer: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  version: Schema.String,
  build: Schema.String,
});
const decodeConstants = Schema.decodeUnknownEffect(Schema.fromJsonString(Constants));
const decodeSavedUser = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ Email: Schema.NonEmptyString, Password: Schema.NonEmptyString }),
  ),
);

/** The login Soundly saved (Remember me): its email and the salted hash it sends. */
export const savedLogin = (run: Run) =>
  Effect.gen(function* () {
    const result = yield* run("plutil", ["-extract", "SavedUser", "json", "-o", "-", PREFS]);
    if (result.exitCode !== 0)
      return yield* new SoundlyError({
        message: "Soundly has no saved sign-in: sign in to Soundly once with Remember me on",
      });
    return yield* decodeSavedUser(result.stdout).pipe(
      Effect.mapError(() => new SoundlyError({ message: "Soundly's saved sign-in is unreadable" })),
    );
  });

/** `signIn`: a new session from the saved login (this signs the desktop app out). `script` is `app_constants.py`. */
export const cloud = (run: Run, script: string) => {
  let cached: { readonly build: string; readonly constants: typeof Constants.Type } | undefined;

  const constants = Effect.gen(function* () {
    const info = yield* run("plutil", [
      "-extract",
      "CFBundleVersion",
      "raw",
      "-o",
      "-",
      `${APP}/Contents/Info.plist`,
    ]);
    if (info.exitCode !== 0)
      return yield* new SoundlyError({ message: `Soundly is not installed at ${APP}` });
    const build = info.stdout.trim();
    if (cached?.build === build) return cached.constants;
    const result = yield* run(`${APP}/Contents/MacOS/python`, [script], {
      cwd: RESOURCES,
      env: {
        PYTHONHOME: RESOURCES,
        PYTHONPATH: [
          `${RESOURCES}/lib/python39.zip`,
          `${RESOURCES}/lib/python3.9`,
          `${RESOURCES}/lib/python3.9/lib-dynload`,
        ].join(":"),
      },
    });
    const read = yield* decodeConstants(result.stdout.trim().split("\n").at(-1) ?? "").pipe(
      Effect.mapError(
        () =>
          new SoundlyError({
            message: `could not read Soundly ${build}'s API constants (exit ${result.exitCode}): ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
          }),
      ),
    );
    cached = { build, constants: read };
    return read;
  });

  const post = (host: string, fields: Readonly<Record<string, unknown>>) => {
    const type = String(fields["Type"]);
    return Effect.tryPromise({
      try: async () => {
        // Bytes, not a string: a string body gets a Content-Type, and Soundly answers 401 to a form one.
        const response = await fetch(`https://${host}`, {
          method: "POST",
          body: new TextEncoder().encode(encodeForm(fields)),
          headers: { "User-Agent": "python-requests/2.31.0", Accept: "*/*" },
          signal: AbortSignal.timeout(45_000),
        });
        return { status: response.status, text: await response.text() };
      },
      catch: (error) => new SoundlyError({ message: `${type}: ${String(error)}` }),
    }).pipe(
      Effect.flatMap(({ status, text }) => {
        if (status === 205)
          return Effect.fail(
            new SoundlyError({ message: `${type}: Soundly ended the session (forcelogout)` }),
          );
        if (status >= 400)
          return Effect.fail(
            new SoundlyError({ message: `${type}: HTTP ${status} ${text.slice(0, 120)}` }),
          );
        return Effect.try({
          try: () => decodeReply(text),
          catch: () =>
            new SoundlyError({ message: `${type}: unreadable reply ${text.slice(0, 120)}` }),
        });
      }),
    );
  };

  const signIn = Effect.gen(function* () {
    const app = yield* constants;
    const login = yield* savedLogin(run);
    const os = yield* run("sw_vers", ["-productVersion"]);
    // Soundly answers a call without the last DbState it sent with 205 forcelogout.
    let dbState: unknown = undefined;
    const keepState = (items: Reply) => {
      const state = field(items, "DbState");
      if (state !== undefined) dbState = state;
      return items;
    };
    const signedIn = keepState(
      yield* post(app.server, {
        Type: "Login",
        Email: login.Email,
        Password: login.Password,
        ClientID: app.clientId,
        SoundlyVersion: app.version,
        BuildNumber: app.build,
        System: "macOS",
        Platform: "Darwin",
        PlatformVersion: os.stdout.trim(),
        server_token: app.token,
      }),
    );
    const sessionId = field(signedIn, "SessionID");
    if (typeof sessionId !== "string" || sessionId === "")
      return yield* new SoundlyError({
        message: `sign-in refused: ${String(field(signedIn, "Error") ?? "no session")}`,
      });
    const libraries = rows(field(signedIn, "LibraryAccess")).flatMap(
      (row): ReadonlyArray<Library> => {
        const id = row["LibraryID"];
        return typeof id === "string" ? [{ id, name: String(row["Name"] ?? id) }] : [];
      },
    );

    /** One call in the session; Soundly's `"<n>: <text>"` errors fail it unless `allow` accepts them. */
    const call = (
      fields: Readonly<Record<string, unknown>>,
      host = app.server,
      allow?: (error: string) => boolean,
    ) =>
      post(host, {
        ...fields,
        SessionID: sessionId,
        server_token: app.token,
        db_state: dbState,
      }).pipe(
        Effect.map(keepState),
        Effect.flatMap((items) => {
          const error = field(items, "Error");
          return typeof error !== "string" || allow?.(error) === true
            ? Effect.succeed(items)
            : Effect.fail(new SoundlyError({ message: `${String(fields["Type"])}: ${error}` }));
        }),
      );

    const searchOn = (
      type: "HybridSearch" | "Search",
      host: string,
      query: string,
      pageSize: number,
    ) =>
      Effect.map(
        call(
          {
            Type: type,
            SearchString: query,
            LibraryIDs: libraries.map((library) => library.id).join(","),
            CategoryID: "",
            ZipResponse: true,
            UseThesaurus: true,
            SearchID: `eva-${crypto.randomUUID()}`,
            SearchFilters: {},
            PageSize: pageSize,
          },
          host,
        ),
        (items) => toMatches(field(items, "SearchMatches")),
      );

    const collections = Effect.map(call({ Type: "GetPlaylists", ZipResponse: true }), (items) =>
      toCollections(field(items, "Playlists")),
    );

    const api: SoundlyApi = {
      libraries,
      search: (query, pageSize) =>
        libraries.length === 0
          ? Effect.fail(new SoundlyError({ message: "the account can search no cloud library" }))
          : searchOn("HybridSearch", app.semanticServer, query, pageSize).pipe(
              Effect.map((matches) => ({ mode: "semantic" as const, matches })),
              Effect.catch(() =>
                Effect.map(searchOn("Search", app.server, query, pageSize), (matches) => ({
                  mode: "keyword" as const,
                  matches,
                })),
              ),
            ),
      collections,
      create: (name) =>
        Effect.gen(function* () {
          const before = new Set((yield* collections).map((collection) => collection.key));
          yield* call({ Type: "NewPlaylist", Name: name, ParentPlaylist: "", ParentFolder: "" });
          const made = (yield* collections).filter(
            (collection) => !before.has(collection.key) && collection.name === name,
          );
          if (made.length !== 1)
            return yield* new SoundlyError({
              message: `NewPlaylist: expected one new collection named ${name}, found ${made.length}`,
            });
          return made[0]!;
        }),
      add: (key, sounds) =>
        Effect.asVoid(
          call({
            Type: "AddFilesToPlaylist",
            PlaylistKey: key,
            Data: sounds.map((sound) => ({
              FileID: sound.id,
              Location: "Cloud",
              LibraryID: sound.libraryId,
              IdentifierData: null,
            })),
            FolderID: "",
          }),
        ),
      fileIds: (key) =>
        Effect.map(
          call({
            Type: "GetPlaylist",
            PlaylistKey: key,
            FolderID: "",
            Start: 0,
            End: 5000,
            LoadFromCache: false,
            ZipResponse: true,
            SearchID: `eva-${crypto.randomUUID()}`,
          }),
          (items) => rows(field(items, "PlaylistFiles")).map((file) => String(file["FileID"])),
        ),
      remove: (key) =>
        Effect.gen(function* () {
          // Soundly answers a deleted collection with the new list plus a spurious "58: no permission".
          yield* call({ Type: "DeletePlaylist", Key: key, FolderID: "" }, app.server, (error) =>
            error.startsWith("58:"),
          );
          if ((yield* collections).some((collection) => collection.key === key))
            return yield* new SoundlyError({ message: `DeletePlaylist: ${key} is still there` });
        }),
    };
    return api;
  });

  return { signIn };
};
