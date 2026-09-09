import type { StateStorage } from "zustand/middleware";
import { File, Paths } from "expo-file-system";

/**
 * zustand `persist` storage backed by expo-file-system's `File` API. Chosen over expo-secure-store
 * (size-limited, meant for secrets) and react-native-mmkv (extra native module + config);
 * expo-file-system is already a transitive dependency of `expo` and needs no additional native
 * setup for the dev client. `expo-file-system/legacy` was considered too: its runtime API is
 * simpler, but its `.d.ts` resolution pulls in untyped source that fails this project's
 * `verbatimModuleSyntax` checks, so the current synchronous `File` API is used instead.
 */
function fileFor(name: string): File {
  return new File(Paths.document, `${name}.json`);
}

export const fileStorage: StateStorage = {
  async getItem(name) {
    const file = fileFor(name);
    if (!file.exists) return null;
    return file.text();
  },
  setItem(name, value) {
    const file = fileFor(name);
    if (!file.exists) file.create();
    file.write(value);
  },
  removeItem(name) {
    const file = fileFor(name);
    if (file.exists) file.delete();
  },
};
