import { useState } from 'react'
import { Anchor, Checkbox, Stack, Tabs, Text } from '@mantine/core'
import type { RecipeIngredient, RecipeSpec } from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { WidgetTitle } from './parts'

interface Group {
  section: string | null
  items: { item: string; index: number }[]
}

/** Ingredients split where a `section` starts a new group; leading items have no heading. */
export function ingredientGroups(ingredients: RecipeIngredient[]): Group[] {
  const groups: Group[] = []
  ingredients.forEach((ingredient, index) => {
    const current = groups.at(-1)
    if (current === undefined || (ingredient.section !== undefined && ingredient.section !== '')) {
      groups.push({ section: ingredient.section || null, items: [] })
    }
    groups.at(-1)!.items.push({ item: ingredient.item, index })
  })
  return groups
}

/**
 * Interactive recipe (widgets.rs recipe): an Ingredients tab of checkable items grouped by
 * section, and a Details tab with the meta facts, numbered directions and the source link.
 */
export function RecipeWidget({ spec }: { spec: RecipeSpec }) {
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const toggle = (i: number): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (!next.delete(i)) next.add(i)
      return next
    })
  const source = (() => {
    if (spec.source === undefined) return null
    try {
      return new URL(spec.source).hostname.replace(/^www\./, '')
    } catch {
      return spec.source
    }
  })()
  return (
    <Stack gap="sm" data-testid="widget-recipe">
      <WidgetTitle>{spec.title}</WidgetTitle>
      <Tabs defaultValue="ingredients" variant="outline">
        <Tabs.List>
          <Tabs.Tab value="ingredients">Ingredients</Tabs.Tab>
          <Tabs.Tab value="details">Details</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ingredients" pt="sm">
          <Stack gap="sm">
            {ingredientGroups(spec.ingredients).map((group, g) => (
              <Stack key={g} gap={6}>
                {group.section !== null ? (
                  <Text size="xs" fw={600} c="dimmed">
                    {group.section}
                  </Text>
                ) : null}
                {group.items.map(({ item, index }) => (
                  <Checkbox
                    key={index}
                    size="xs"
                    checked={checked.has(index)}
                    onChange={() => toggle(index)}
                    label={
                      <Text
                        component="span"
                        size="sm"
                        className={checked.has(index) ? 'eva-w-recipe-done' : ''}
                      >
                        {item}
                      </Text>
                    }
                  />
                ))}
              </Stack>
            ))}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="details" pt="sm">
          <Stack gap="sm">
            {spec.meta !== undefined && spec.meta.length > 0 ? (
              <Text size="xs" c="dimmed">
                {spec.meta.join(' · ')}
              </Text>
            ) : null}
            <ol className="eva-w-recipe-steps">
              {spec.directions.map((step, i) => (
                <li key={i}>
                  <Text size="sm">{step}</Text>
                </li>
              ))}
            </ol>
            {spec.source !== undefined ? (
              <Text size="xs" c="dimmed">
                Source:{' '}
                <Anchor
                  size="xs"
                  href={spec.source}
                  onClick={(e) => {
                    e.preventDefault()
                    openLink(spec.source!)
                  }}
                >
                  {source}
                </Anchor>
              </Text>
            ) : null}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
