import type { WebContents } from 'electron'

/**
 * CDP control of one page through `webContents.debugger`. Main-process only (agents later); it
 * attaches lazily and treats a `detach` (DevTools closing, crash) as normal: the next call
 * re-attaches. DevTools and this client coexist on Electron 44 (multi-client CDP).
 *
 * Navigation is not done here: `load` is the host's `navigate()`, the one place that applies the
 * guest protocol allow-list and keeps the tab state in step, so an agent handing this class a
 * `file:` or `chrome:` URL gets the same blocked card as the address bar.
 */
export class PageControl {
  constructor(
    private readonly wc: WebContents,
    private readonly load: (url: string) => void,
  ) {
    wc.debugger.on('detach', () => {
      /* next call re-attaches */
    })
  }

  ensureAttached(): void {
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.ensureAttached()
    const res = (await this.wc.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } }
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'evaluate failed')
    return res.result?.value as T
  }

  readText(): Promise<string> {
    return this.evaluate<string>('document.body.innerText')
  }

  async click(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
    )
  }

  navigate(url: string): void {
    this.load(url)
  }
}
