import { UsageMeter } from '../usage/UsageMeter'

/** Full-width strip under the sidebar, main card and panel (native EvaOS footer). */
export function Footer() {
  return (
    <footer className="eva-footer" data-testid="footer">
      <UsageMeter />
    </footer>
  )
}
