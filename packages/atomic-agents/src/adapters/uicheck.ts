import { Context, Effect, Layer, Option, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { ChildProcessSpawner } from "effect/process"
import { pack } from "../Adapter.ts"
import type { ToolsError } from "../Component.ts"
import { exec } from "../exec.ts"
import { EvaRoot } from "./eva.ts"

export class UiCheckError extends Schema.TaggedError<UiCheckError>()("UiCheckError", {
  message: Schema.String
}) {}

/** One ui-check finding, as much of it as evidence needs. */
export const Measurement = Schema.Struct({
  rule: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  selector: Schema.String,
  label: Schema.optionalKey(Schema.String),
  viewport: Schema.Array(Schema.Number),
  fix: Schema.String
})
export type Measurement = typeof Measurement.Type

const Report = Schema.Struct({ findings: Schema.Array(Measurement) })
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report))

/**
 * Eva's layout measurer (`.omp/tools/ui-check.ts` under `EVA_ROOT`): loads the page in its own headless
 * Chromium at each width and measures every element. Static audit only (no `--states`), never `--cdp`.
 */
export class UiCheck extends Context.Service<UiCheck, {
  measure(url: string, viewports: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<Measurement>, UiCheckError>
}>()("atomic-agents/ui-check/UiCheck") {
  static readonly layer = Layer.effect(
    UiCheck,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const tool = `${yield* EvaRoot}/.omp/tools/ui-check.ts`
      const measure = Effect.fn("UiCheck.measure")(function*(url: string, viewports: ReadonlyArray<number>) {
        const result = yield* exec(process.execPath, [tool, url, ...(viewports.length > 0 ? ["--viewports", viewports.join(",")] : [])]).pipe(
          Effect.timeoutOrElse({ duration: "3 minutes", orElse: () => Effect.fail(new UiCheckError({ message: `ui-check ${url} timed out` })) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(new UiCheckError({ message: error.message })))
        )
        // 0 clean, 1 error findings, 2 usage or load failure.
        if (result.exitCode > 1) return yield* new UiCheckError({ message: `ui-check ${url} exited ${result.exitCode}: ${result.stderr.trim().slice(-300)}` })
        const report = yield* decodeReport(result.stdout).pipe(Effect.mapError((error) => new UiCheckError({ message: `ui-check output: ${error.message}` })))
        return report.findings
      }, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return UiCheck.of({ measure })
    })
  )
}

/** Critique rules ui-check can measure, and the ui-check rules that confirm each. */
export const MEASURED: Readonly<Record<string, ReadonlyArray<string>>> = {
  "overlap": ["overlap", "overlay-overlap"],
  "clipped-text": ["text-clipped", "text-overflow", "truncated", "popover-clipped"],
  "page-overflow": ["page-overflow", "viewport-meta"],
  "touch-target": ["touch-target"],
  "alignment": ["misaligned", "row-mismatch", "uneven-gap", "sibling-drift"],
  "tiny-text": ["tiny-text", "line-height"]
}

const RANK: Readonly<Record<string, number>> = { blocking: 0, major: 1, minor: 2 }
const EVIDENCE = 20

const Finding = Schema.Struct({ rule: Schema.String, element: Schema.String, fix: Schema.String, severity: Schema.String })
const Critique = Schema.Struct({ score: Schema.Number, findings: Schema.Array(Finding), summary: Schema.String })
const decodeCritique = Schema.decodeUnknownEffect(Critique)

const Target = Schema.Struct({ url: Schema.optionalKey(Schema.String), viewports: Schema.optionalKey(Schema.Array(Schema.Number)) })
const decodeTarget = Schema.decodeUnknownOption(Target)

/** The ui-check adapters over `layer` (the real tool, or a test fake). */
export const uiCheckPack = (layer: Layer.Layer<UiCheck, ToolsError, BunServices> = UiCheck.layer) =>
  pack({
    name: "ui-check",
    layer,
    checks: [{
      name: "ui-check.evidence",
      description:
        "For a critique answer {score, findings[{rule, element, fix, severity}], summary}: the score must be 0 to 10 and a score under 10 must name a fix, else one repair turn (still wrong fails the item). Findings are ranked blocking, major, minor (the model's order within each). With a url field, ui-check measures the page at the same viewports: its errors and warnings become evidence (at most 20, errors first) and each finding on a measurable rule gets measured: true when ui-check found that kind of defect, false when it found none. Provides findings and evidence.",
      provides: ["findings", "evidence"],
      check: (reply, context) =>
        Effect.gen(function*() {
          const critique = yield* decodeCritique(reply.answer).pipe(
            Effect.mapError((error) => new UiCheckError({ message: `ui-check.evidence needs a critique answer: ${error.message}` }))
          )
          const problems = [
            ...(critique.score >= 0 && critique.score <= 10 ? [] : [`score ${critique.score} is outside 0 to 10`]),
            ...(critique.score < 10 && critique.findings.length === 0 ? [`a score of ${critique.score} needs at least one finding saying what to fix`] : [])
          ]
          if (problems.length > 0) {
            return {
              pass: false as const,
              repair: [context.prompt, "## Your last answer", reply.text, "## What is wrong with it", ...problems.map((problem) => `- ${problem}`), "Answer again, fixed."].join("\n\n"),
              giveUp: Effect.fail(new UiCheckError({ message: `critique still invalid after one repair: ${problems.join("; ")}` }))
            }
          }
          const ranked = critique.findings
            .map((finding, index) => ({ finding, index }))
            .sort((a, b) => (RANK[a.finding.severity] ?? 3) - (RANK[b.finding.severity] ?? 3) || a.index - b.index)
            .map(({ finding }) => finding)
          const { url, viewports = [] } = Option.getOrElse(decodeTarget(context.fields), (): typeof Target.Type => ({}))
          if (url === undefined) return { pass: true as const, fields: { findings: ranked } }
          const measured = yield* (yield* UiCheck).measure(url, viewports).pipe(
            Effect.tapError((error) => Effect.logWarning(`ui-check.evidence: no evidence for ${url}: ${error.message}`)),
            Effect.option
          )
          if (Option.isNone(measured)) return { pass: true as const, fields: { findings: ranked } }
          // Info findings are context, not defects: they neither confirm a finding nor count as evidence.
          const defects = measured.value.filter((entry) => entry.severity !== "info")
          const found = new Set(defects.map((entry) => entry.rule))
          const evidence = defects
            .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
            .slice(0, EVIDENCE)
            .map((entry) => ({ rule: entry.rule, severity: entry.severity, selector: entry.selector, ...(entry.label ? { label: entry.label } : {}), viewport: entry.viewport, fix: entry.fix }))
          return {
            pass: true as const,
            fields: {
              findings: ranked.map((finding) => {
                const confirms = MEASURED[finding.rule]
                return confirms === undefined ? finding : { ...finding, measured: confirms.some((rule) => found.has(rule)) }
              }),
              evidence
            }
          }
        })
    }]
  })
