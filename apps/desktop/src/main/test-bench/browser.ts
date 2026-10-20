import { BaseWindow, WebContentsView, session } from 'electron'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { BenchObservationsSchema, type BenchEnvelope, type BenchLimits } from '@evaos/contract'
import { PageControl } from '../browser/page-control'
import { fixtureHtml, type Fixture } from './fixtures'

export interface Collection {
  observations: BenchEnvelope['observations']
  before: Buffer
  after: Buffer
}
export type Collector = (
  fixture: Fixture,
  limits: BenchLimits,
  signal: AbortSignal,
) => Promise<Collection>
const measurement = `(() => {
  const field=document.querySelector('#field'), label=document.querySelector('label'), panel=document.querySelector('#panel');
  const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
  const range=document.createRange();range.selectNodeContents(label);
  const t=range.getBoundingClientRect(), c=field.getBoundingClientRect(), p=panel.getBoundingClientRect();
  const outside=r=>r.left<p.left||r.right>p.right||r.top<p.top||r.bottom>p.bottom||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight;
  return {viewport:{width:innerWidth,height:innerHeight},label:{associated:Array.from(field.labels||[]).includes(label),text:label.innerText},clipping:{clipped:outside(t)||outside(c),text:rect(t),control:rect(c),container:rect(p)},keyboard:null,persistence:null,pageText:document.querySelector('aside').innerText};
})()`
const focus = `document.activeElement.id==='field'?'field':document.activeElement.id==='save'?'save':document.activeElement===document.body?'body':'other'`
const paint = `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`

export const collectBrowser: Collector = async (fixture, limits, signal) => {
  signal.throwIfAborted()
  const isolated = session.fromPartition(`test-bench-${randomUUID()}`, { cache: false })
  const server = createServer((_req, res) => {
    if (_req.url !== '/form' || _req.method !== 'GET') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    })
    res.end(fixtureHtml(fixture))
  })
  let win: BaseWindow | undefined
  let view: WebContentsView | undefined
  let stopped = false
  const interrupted = Promise.withResolvers<never>()
  const stop = (): void => {
    stopped = true
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
    if (win && !win.isDestroyed()) win.destroy()
    server.closeAllConnections()
    server.close()
  }
  const abort = (): void => {
    stop()
    interrupted.reject(new Error('Browser collection cancelled'))
  }
  signal.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => {
    stop()
    interrupted.reject(new Error('Browser capture deadline exceeded'))
  }, limits.captureMs)
  try {
    return await Promise.race([
      interrupted.promise,
      (async () => {
        const listening = Promise.withResolvers<void>()
        server.once('error', listening.reject)
        server.listen(0, '127.0.0.1', listening.resolve)
        await listening.promise
        signal.throwIfAborted()
        if (stopped) throw new Error('Browser collection stopped')
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Fixture origin unavailable')
        const url = `http://127.0.0.1:${address.port}/form`
        isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
        isolated.setPermissionCheckHandler(() => false)
        isolated.setDevicePermissionHandler(() => false)
        isolated.webRequest.onBeforeRequest((details, callback) =>
          callback({ cancel: details.url !== url || details.method !== 'GET' }),
        )
        win = new BaseWindow({ width: 800, height: 600, show: false })
        win.setOpacity(0)
        win.setIgnoreMouseEvents(true)
        view = new WebContentsView({
          webPreferences: {
            session: isolated,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            backgroundThrottling: false,
            spellcheck: false,
          },
        })
        win.contentView.addChildView(view)
        view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
        const wc = view.webContents
        wc.setWindowOpenHandler(() => ({ action: 'deny' }))
        wc.on('will-navigate', (event, target) => {
          if (target !== url) event.preventDefault()
        })
        wc.on('will-redirect', (event) => event.preventDefault())
        wc.on('will-attach-webview', (event) => event.preventDefault())
        isolated.on('will-download', (event) => event.preventDefault())
        const control = new PageControl(wc, () => {})
        await wc.loadURL(url)
        win.showInactive()
        await control.evaluate(paint)
        const capture = async (): Promise<Buffer> => {
          signal.throwIfAborted()
          const image = await wc.capturePage()
          if (image.isEmpty()) throw new Error('Empty browser capture')
          const bitmap = image.toBitmap()
          let varied = false
          for (let i = 4; i < bitmap.length; i += 4) {
            if (
              bitmap[i] !== bitmap[0] ||
              bitmap[i + 1] !== bitmap[1] ||
              bitmap[i + 2] !== bitmap[2]
            ) {
              varied = true
              break
            }
          }
          if (!varied) throw new Error('Blank browser capture')
          const png = image.toPNG()
          if (png.length > limits.pngBytes) throw new Error('PNG exceeds capture limit')
          return png
        }
        const before = await capture()
        const observations = BenchObservationsSchema.parse(await control.evaluate(measurement))
        // CDP dispatch targets the disposable page, without focusing an OS window.
        const key = async (name: 'Tab' | 'Enter' | 'a'): Promise<void> => {
          const event = {
            key: name,
            code: name === 'a' ? 'KeyA' : name,
            windowsVirtualKeyCode: name === 'Tab' ? 9 : name === 'Enter' ? 13 : 65,
            modifiers: name === 'a' ? (process.platform === 'darwin' ? 4 : 2) : 0,
          }
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            ...event,
            type: 'keyDown',
            ...(name === 'a'
              ? { commands: ['selectAll'] }
              : name === 'Enter'
                ? { text: String.fromCharCode(13) }
                : {}),
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' })
          await control.evaluate(paint)
        }
        if (!fixture.withheld && fixture.action === 'keyboard') {
          const sequence: NonNullable<BenchEnvelope['observations']['keyboard']>['sequence'] = []
          await key('Tab')
          sequence.push(await control.evaluate(focus))
          await key('Tab')
          sequence.push(await control.evaluate(focus))
          observations.keyboard = { sequence }
        }
        if (!fixture.withheld && fixture.action === 'persistence') {
          const beforeValue = await control.evaluate<string>(
            "document.querySelector('#field').value",
          )
          await key('Tab')
          await key('a')
          await wc.debugger.sendCommand('Input.insertText', { text: fixture.entered })
          const entered = await control.evaluate<string>("document.querySelector('#field').value")
          await key('Tab')
          await key('Enter')
          const afterSave = await control.evaluate<string>("document.querySelector('#field').value")
          await wc.loadURL(url)
          await control.evaluate(paint)
          observations.persistence = {
            before: beforeValue,
            entered,
            afterSave,
            afterReload: await control.evaluate<string>("document.querySelector('#field').value"),
          }
        }
        if (fixture.withheld) observations[fixture.action] = null
        const after = await capture()
        return { observations: BenchObservationsSchema.parse(observations), before, after }
      })(),
    ])
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    stop()
    await isolated.closeAllConnections()
    await isolated.clearStorageData()
    isolated.webRequest.onBeforeRequest(null)
  }
}
