/**
 * The runtime of the ```openui fence a widget sits in, for its `action` buttons and bound inputs.
 * Null outside a fence (```ui JSON, dashboards), where those fields never occur.
 */
import { createContext, useContext } from "react";
import type { OpenUIRuntime } from "@relay/protocol";

export const OpenUIRuntimeContext = createContext<OpenUIRuntime | null>(null);

export function useOpenUIRuntime(): OpenUIRuntime | null {
  return useContext(OpenUIRuntimeContext);
}
