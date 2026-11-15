import { gmail } from "./components/gmail/component.ts"
import { propRender } from "./components/prop-render/component.ts"
import { widget } from "./components/widget/component.ts"

/** The built-in components with their code defaults: what the CLI, the service and the bench scripts register. */
export const builtins = [propRender, gmail, widget]
