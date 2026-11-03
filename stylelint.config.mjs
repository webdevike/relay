// Spacing on Mantine's scale: padding, margin and gap take 0, a Mantine spacing variable (or a
// fraction or multiple of one), or the shell's approved var(--eva-gap). Shorthands take up to
// four such values. scripts/lint-spacing.ts runs this over the renderer CSS against a baseline
// of older violations that may only shrink.
const SIZE = '(?:xs|sm|md|lg|xl)'
const SPACING = `var\\(--mantine-spacing-${SIZE}\\)`
const TOKEN = [
  '0',
  'auto',
  SPACING,
  'var\\(--eva-gap\\)',
  `calc\\(${SPACING} [*/] \\d+(?:\\.\\d+)?\\)`,
  `calc\\(-1 \\* (?:${SPACING}|var\\(--eva-gap\\))\\)`,
].join('|')
const VALUE = new RegExp(`^(?:${TOKEN})(?:\\s+(?:${TOKEN})){0,3}$`)

/** @type {import('stylelint').Config} */
export default {
  rules: {
    'declaration-property-value-allowed-list': {
      '/^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/': [
        VALUE,
      ],
      '/^(?:gap|row-gap|column-gap)$/': [VALUE],
    },
  },
}
