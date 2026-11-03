import { StringDecoder } from 'node:string_decoder'

export type Frame = Record<string, unknown> & { type: string }

/**
 * Splits an omp rpc-ui byte stream into JSON frames (D-15).
 * - splits on "\n" only (not a line-reader helper: U+2028/2029 may appear inside JSON strings)
 * - StringDecoder keeps multibyte characters intact across chunk boundaries
 * - a bad line is reported through onBadLine and never drops its neighbours
 * - no line length cap here; omp v1 lines are at most 1 MiB (maxFrameBytes)
 */
export class LineFramer {
  private dec = new StringDecoder('utf8')
  private carry = ''

  constructor(
    private onFrame: (f: Frame) => void,
    private onBadLine?: (line: string, err: unknown) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.carry += typeof chunk === 'string' ? chunk : this.dec.write(chunk)
    let i: number
    while ((i = this.carry.indexOf('\n')) >= 0) {
      const line = this.carry.slice(0, i).replace(/\r$/, '')
      this.carry = this.carry.slice(i + 1)
      this.line(line)
    }
  }

  end(): void {
    const tail = (this.carry + this.dec.end()).replace(/\r$/, '')
    this.carry = ''
    this.line(tail)
  }

  private line(line: string): void {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      this.onBadLine?.(line, e)
      return
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      this.onFrame(parsed as Frame)
    }
  }
}
