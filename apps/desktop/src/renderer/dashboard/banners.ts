import mountainsLight from '../assets/banners/mountains-light.png'
import mountainsDark from '../assets/banners/mountains-dark.png'
import canyonLight from '../assets/banners/canyon-light.png'
import canyonDark from '../assets/banners/canyon-dark.png'
import redwoodsLight from '../assets/banners/redwoods-light.png'
import redwoodsDark from '../assets/banners/redwoods-dark.png'
import coastLight from '../assets/banners/coast-light.png'
import coastDark from '../assets/banners/coast-dark.png'

/** Static imports so Vite hashes and bundles them (Pitfall 11). Order is the rotation order. */
export const BANNERS: { light: string[]; dark: string[] } = {
  light: [mountainsLight, canyonLight, redwoodsLight, coastLight],
  dark: [mountainsDark, canyonDark, redwoodsDark, coastDark],
}

export const BANNER_ROTATE_MS = 9000
