import { PageRouter } from '../pages/PageRouter'
import { TabBar } from '../tabs/TabBar'
import { useTabs } from '../tabs/tabs-store'

/** Tab strip on top; page router below. */
export function MainCard() {
  const loaded = useTabs((s) => s.loaded)
  if (!loaded) return null
  return (
    <>
      <TabBar />
      <PageRouter />
    </>
  )
}
