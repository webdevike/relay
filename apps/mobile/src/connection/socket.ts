/**
 * Thin `WebSocket` wrapper: text frames only, a guarded `send`, and handler fields the driver
 * assigns once. `open` always tears down any prior socket first, so callers never need to close
 * one connection before opening the next.
 *
 * Every socket gets an epoch (1, 2, ...) when it is opened, and its end is reported exactly once
 * through `onClose(epoch, local)`, whoever ended it: the peer, `close()`, or `open()` replacing it.
 * Whatever belonged to that socket (a call on it, requests sent on it) can then end with it, even
 * when the socket was swapped silently for a new one.
 */
export class RelaySocket {
  onOpen: (() => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  /** `local` is true when this side closed it (`close()`, or `open()` replacing it). */
  onClose: ((epoch: number, local: boolean) => void) | null = null;
  onError: ((error: unknown) => void) | null = null;

  private ws: WebSocket | null = null;
  private wsEpoch = 0;
  private latest = 0;

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** The epoch of the socket opened last (0 before the first `open`), whether or not it is still open. */
  get epoch(): number {
    return this.latest;
  }

  open(url: string): void {
    // The new epoch exists before the old socket's end is reported, so a listener can tell that
    // end is a replacement (`epoch < this.epoch`) rather than the connection going away.
    this.latest += 1;
    this.close();
    const epoch = this.latest;
    const ws = new WebSocket(url);
    ws.onopen = () => this.onOpen?.();
    ws.onmessage = (event) => {
      if (typeof event.data === "string") this.onMessage?.(event.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.onClose?.(epoch, false);
    };
    ws.onerror = (event) => this.onError?.(event);
    this.ws = ws;
    this.wsEpoch = epoch;
  }

  /** No-op, returns `false`, unless the socket is OPEN. */
  send(text: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  /** Idempotent. Reports the socket's end at once; its own late `onclose` is never delivered. */
  close(): void {
    const ws = this.ws;
    if (ws === null) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    this.onClose?.(this.wsEpoch, true);
  }
}
