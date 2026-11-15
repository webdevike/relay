import type { Pack } from "../Adapter.ts"
import { blender } from "./blender/pack.ts"
import { browserPack } from "./browser.ts"
import { ecardPack } from "./ecard/pack.ts"
import { gmailPack } from "./gmail/pack.ts"
import { omp } from "./omp.ts"
import { openui } from "./openui.ts"
import { researchPack } from "./research/pack.ts"
import { uiCheckPack } from "./uicheck.ts"
import { widget } from "./widget.ts"

/** Every adapter pack this package ships: what the CLI, the service and the benches assemble chefs from. */
export const packs: ReadonlyArray<Pack> = [omp, gmailPack(), ecardPack(), openui, blender, widget, browserPack(), uiCheckPack(), researchPack()]
