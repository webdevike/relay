/** Toolbar actions of the Chrome extensions loaded in persist:browser (BROW-08). */
export function ExtensionActions() {
  return (
    <div className="eva-extension-actions" data-testid="extension-actions">
      <browser-action-list partition="persist:browser" alignment="bottom left" />
    </div>
  )
}
