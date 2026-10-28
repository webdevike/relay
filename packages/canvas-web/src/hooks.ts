import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Presence, SessionInfo } from "../../canvas-live/src/shared";
import { roomAgent } from "./model";
import { presenceStates, provider, roomMe, subscribeDoc, subscribePresence, yMeta } from "./room";

let docVersion = 0;
subscribeDoc(() => docVersion++);

/** Re-reads a Y value whenever the doc changes; stable between changes. */
export function useYSnapshot<T>(read: () => T): T {
	const cache = useRef<{ v: number; value: T } | null>(null);
	const version = useSyncExternalStore(subscribeDoc, () => docVersion);
	if (!cache.current || cache.current.v !== version) cache.current = { v: version, value: read() };
	return cache.current.value;
}

/** Everyone's presence, at most once per frame. */
export function useThrottledPresence(): Map<number, Presence> {
	const [states, setStates] = useState(() => new Map(presenceStates()));
	useEffect(() => {
		let raf = 0;
		const off = subscribePresence(() => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				setStates(new Map(presenceStates()));
			});
		});
		return () => {
			off();
			cancelAnimationFrame(raf);
		};
	}, []);
	return states;
}

export function useSession(): SessionInfo | undefined {
	return useYSnapshot(() => yMeta.get("session") as SessionInfo | undefined);
}

/** The agent's name and color for copy ("Follow Nova"), from the session, `/me` or presence. */
export function useAgent(): { name: string; color: string } {
	const session = useSession();
	const people = useThrottledPresence();
	const a = roomAgent(
		session,
		roomMe?.agent ?? null,
		[...people.values()].flatMap((p) => (p.user ? [p.user] : [])),
	);
	return { name: a?.name ?? "the agent", color: a?.color ?? "#8b5cf6" };
}

export type Connection = "connecting" | "live" | "reconnecting";

export function useConnection(): Connection {
	const [state, setState] = useState<Connection>(provider.synced ? "live" : "connecting");
	useEffect(() => {
		let everSynced = provider.synced;
		const onSync = (s: boolean) => {
			if (s) everSynced = true;
			setState(s ? "live" : everSynced ? "reconnecting" : "connecting");
		};
		const onStatus = ({ status }: { status: string }) => {
			if (status !== "connected") setState(everSynced ? "reconnecting" : "connecting");
		};
		provider.on("sync", onSync);
		provider.on("status", onStatus);
		// The first sync may have landed between render and this effect.
		onSync(provider.synced);
		return () => {
			provider.off("sync", onSync);
			provider.off("status", onStatus);
		};
	}, []);
	return state;
}
