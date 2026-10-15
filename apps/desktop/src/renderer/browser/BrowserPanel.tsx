export function BrowserPanel() {
  return (
    <section className="eva-browser" data-testid="browser-panel">
      <div className="eva-tab-strip" />
      <div className="eva-address-row" />
      <div className="eva-browser-slot" data-testid="browser-slot" />
    </section>
  )
}
