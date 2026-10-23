/** Which status dots of each wireframe row are lit (cards.rs wireframe). */
const ROWS = [
  [true, true, false],
  [true, true, false],
  [true, false, true],
  [false, true, true],
  [true, true, false],
  [true, false, true],
  [false, true, true],
] as const

/**
 * A browser window wireframe for an empty frame with a `url`: traffic lights and the address, a
 * sidebar, then table rows with status dots.
 */
export function Wireframe({ url }: { url: string }) {
  return (
    <div className="eva-cv-wire" data-testid="canvas-wireframe">
      <div className="eva-cv-wire-bar">
        <span className="eva-cv-wire-dot" data-tone="danger" />
        <span className="eva-cv-wire-dot" data-tone="warn" />
        <span className="eva-cv-wire-dot" data-tone="success" />
        <span className="eva-cv-wire-url">{url}</span>
      </div>
      <div className="eva-cv-wire-body">
        <div className="eva-cv-wire-side">
          <span className="eva-cv-wire-line" style={{ width: 56 }} />
          <span className="eva-cv-wire-line" data-on="true" style={{ width: 44 }} />
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="eva-cv-wire-line" style={{ width: 44 }} />
          ))}
        </div>
        <div className="eva-cv-wire-main">
          <span className="eva-cv-wire-line eva-cv-wire-heading" style={{ width: 110 }} />
          {ROWS.map((row, i) => (
            <div key={i} className="eva-cv-wire-row">
              <span className="eva-cv-wire-line" style={{ width: 60 }} />
              <span className="eva-cv-wire-grow">
                <span className="eva-cv-wire-line" style={{ width: 80 }} />
              </span>
              {row.map((on, j) => (
                <span key={j} className="eva-cv-wire-dot" data-on={on ? 'true' : undefined} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
