import type { Pack } from "./core/Adapter.ts"
import { omp } from "./core/adapters/omp.ts"
import { browserPack, uiCheckPack } from "../domains/design/index.ts"
import { diagramPack } from "../domains/diagram/index.ts"
import { ecardPack } from "../domains/ecard/index.ts"
import { gmailPack } from "../domains/gmail/index.ts"
import { blender } from "../domains/render/index.ts"
import { researchPack } from "../domains/research/index.ts"
import { openui, widget } from "../domains/widget/index.ts"

/** Every adapter pack this package ships: what the CLI, the service and the benches assemble agents from. */
export const packs: ReadonlyArray<Pack> = [omp, gmailPack(), ecardPack(), openui, blender, widget, browserPack(), uiCheckPack(), researchPack(), diagramPack()]
