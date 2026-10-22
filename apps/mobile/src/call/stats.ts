/**
 * Counts for the call's diagnostics line: reply audio frames that reached JS and went to the player.
 * Written by the connection's call router, read when a call ends; reset at each call start.
 */
export const callStats = { audioIn: 0 };
