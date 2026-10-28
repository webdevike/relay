/**
 * Hands the native live call engine the paired hosts (secrets included; it keeps them in its own
 * Keychain item for lock-screen calls). Never logs them. A no-op on builds without the module.
 */
import { LiveCall } from "../../modules/live-call";
import { liveCallHosts, type LiveHostsInput } from "./liveHosts";

export function configureLiveCall(input: LiveHostsInput): void {
  LiveCall?.configure({ hosts: liveCallHosts(input) });
}
