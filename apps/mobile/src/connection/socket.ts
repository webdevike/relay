/**
 * Thin `WebSocket` wrapper: text frames only, a guarded `send`, and handler fields the driver
 * assigns once. `open` always tears down any prior socket first, so callers never need to close
 * one connection before opening the next.
 */
export class RelaySocket {
  onOpen: (() => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((error: unknown) => void) | null = null;

  private ws: WebSocket | null = null;

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  open(url: string): void {
    this.close();
    const ws = new WebSocket(url);
    ws.onopen = () => this.onOpen?.();
    ws.onmessage = (event) => {
      if (typeof event.data === "string") this.onMessage?.(event.data);
    };
    ws.onclose = () => this.onClose?.();
    ws.onerror = (event) => this.onError?.(event);
    this.ws = ws;
  }

  /** No-op, returns `false`, unless the socket is OPEN. */
  send(text: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  /** Idempotent. */
  close(): void {
    const ws = this.ws;
    if (ws === null) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
}
