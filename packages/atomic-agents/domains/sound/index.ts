/** Sound: find sounds in Soundly and stage them in a temporary collection (soundly-picks, soundly-cleanup). The domain's public entry: code outside `domains/sound/` imports only this file. */
export { AppState, Soundly, SoundlyError } from "./adapters/soundly.ts";
export { SoundCollected, SoundRequested } from "./schema.ts";
