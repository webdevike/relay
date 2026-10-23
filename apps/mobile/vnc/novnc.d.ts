// The slice of noVNC 1.7 (`core/rfb.js`, plain JS) the live view page uses. Underscored members
// are noVNC internals the page reaches into for local pinch zoom; recheck them on upgrades.
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
  }

  export interface RfbOptions {
    credentials?: RfbCredentials;
    shared?: boolean;
    wsProtocols?: string[];
  }

  /** `gesturestart` / `gesturemove` / `gestureend` from noVNC's GestureHandler. */
  export interface RfbGesture {
    readonly type: "gesturestart" | "gesturemove" | "gestureend";
    readonly detail: {
      readonly type: "onetap" | "twotap" | "threetap" | "drag" | "longpress" | "twodrag" | "pinch";
      readonly clientX: number;
      readonly clientY: number;
      readonly magnitudeX: number;
      readonly magnitudeY: number;
    };
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    sendCredentials(credentials: RfbCredentials): void;
    /** Press and release `keysym` when `down` is omitted. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    disconnect(): void;
    _handleGesture(event: RfbGesture): void;
    readonly _display: { scale: number };
  }
}
