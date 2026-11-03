import { z } from 'zod'

/**
 * Eva's experiments (`$EVA/work/experiments/<yyyy-mm-dd>-<slug>/`), written by `.omp/tools/exp.ts`
 * (types `Summary`, `SummaryArm`, `LiveStatus` in `.omp/tools/lib/exp.ts`) and read here without
 * ever writing. Older experiments have no summary.json; the page then shows results.md. An arm's
 * cost is the token/list-price shape (`ArmCost`) or, in summaries written before it, the legacy
 * `{ perTest, total, unit }` shape; both parse.
 */

/** A folder name under work/experiments; never a path. */
export const ExperimentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/)
/** An arm name as exp.ts allows it. */
export const ArmIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

const num = z.number().finite()
const count = z.number().int().nonnegative()
/** Fractions (p, lo, hi, rates, ece) are 0..1. */
const fraction = z.number().min(0).max(1)
const reason = z.string().optional()

/** `planned` until a round has a verdict or is running. */
export const ExperimentStatusSchema = z.enum(['planned', 'running', 'pass', 'fail', 'inconclusive'])
export type ExperimentStatus = z.infer<typeof ExperimentStatusSchema>

/** One quality rate: k of n with its 95% Wilson interval. */
export const QualityMetricSchema = z.object({
  metric: z.string(),
  split: z.enum(['dev', 'holdout']),
  k: num,
  n: num,
  p: fraction,
  lo: fraction,
  hi: fraction,
})
export type QualityMetric = z.infer<typeof QualityMetricSchema>

const RateSchema = z.object({ k: num, n: num, p: fraction })
export type SummaryRate = z.infer<typeof RateSchema>

const usd = z.number().finite().nonnegative()
const TokensSchema = z.object({ in: num, out: num, cached: num, total: num })
export type CostTokens = z.infer<typeof TokensSchema>

/** One model's share of an arm's tokens; `model` null = run lines that logged no model id. */
export const ModelCostSchema = z.object({
  model: z.string().nullable(),
  calls: count,
  tokensIn: num,
  tokensOut: num,
  tokensCached: num,
  /** Null when this model's tokens have no published price. */
  listUsd: usd.nullable(),
  unpricedReason: reason,
  /** USD per 1M tokens; `source` = provider pricing page URL, `checked` = yyyy-mm-dd. */
  price: z
    .object({
      pattern: z.string(),
      input: usd.nullable(),
      output: usd.nullable(),
      cachedInput: usd.nullable(),
      source: z.string(),
      checked: z.string(),
    })
    .nullable(),
})
export type ModelCost = z.infer<typeof ModelCostSchema>

/** Tokens and what they would cost at published API prices ("list"), plus billed USD if logged. */
export const ArmCostSchema = z.object({
  /** Tests that logged tokens or usd. */
  tests: count,
  tokens: TokensSchema.extend({ perTestMedian: TokensSchema }).nullable(),
  /** perTest = mean; null when any token in the arm is unpriced (never a partial sum). */
  listUsd: z.object({ perTest: usd, perTestMedian: usd, total: usd }).nullable(),
  unpriced: TokensSchema.optional(),
  unpricedReason: reason,
  billedUsd: z.object({ perTest: usd, total: usd, tests: count }).optional(),
  byModel: z.array(ModelCostSchema),
})
export type ArmCost = z.infer<typeof ArmCostSchema>

/** Summaries before ArmCost: unit `tokens` = in+out combined, unit `usd` = billed USD. */
export const LegacyArmCostSchema = z.object({
  perTest: num,
  total: num,
  unit: z.enum(['usd', 'tokens']),
})
export type LegacyArmCost = z.infer<typeof LegacyArmCostSchema>

export function isLegacyCost(c: ArmCost | LegacyArmCost): c is LegacyArmCost {
  return 'unit' in c
}

/**
 * One arm of `summary.json`. A measurement that does not apply is null, with `<name>Reason`
 * holding why (record.md's N/A line or the check that failed).
 */
export const ArmSummarySchema = z.object({
  id: ArmIdSchema,
  label: z.string(),
  role: z.enum(['control', 'baseline', 'treatment']),
  quality: z.array(QualityMetricSchema).nullable(),
  qualityReason: reason,
  seconds: z.object({ median: num, p90: num, total: num }).nullable(),
  secondsReason: reason,
  cost: z.union([ArmCostSchema, LegacyArmCostSchema]).nullable(),
  costReason: reason,
  gap: z
    .object({
      metric: z.string(),
      dev: fraction,
      holdout: fraction,
      diff: z.number().min(-1).max(1),
    })
    .nullable(),
  gapReason: reason,
  repeatAgreement: RateSchema.nullable(),
  repeatAgreementReason: reason,
  failures: z.object({ errors: count, timeouts: count, retries: count, rate: fraction }),
  judgeAudit: RateSchema.nullable(),
  judgeAuditReason: reason,
  calibration: z
    .object({
      ece: fraction,
      bins: z.array(z.object({ lo: num, hi: num, n: count, acc: fraction, conf: fraction })),
    })
    .nullable(),
  calibrationReason: reason,
  coverage: z
    .object({
      run: count,
      planned: count,
      skipped: z.array(z.object({ case: z.string().nullable(), reason: z.string() })),
    })
    .nullable(),
  coverageReason: reason,
  /** This arm's run lines, relative to the experiment folder (e.g. `runs/3/control.jsonl`). */
  casesFile: z.string(),
})
export type ArmSummary = z.infer<typeof ArmSummarySchema>

/** `summary.json`: rewritten each time a round is scored; control first, then record order. */
export const ExperimentSummaryFileSchema = z.object({
  slug: z.string(),
  title: z.string(),
  question: z.string().nullable(),
  created: z.string(),
  updated: z.string(),
  status: ExperimentStatusSchema,
  verdict: z.string().nullable(),
  round: num,
  arms: z.array(ArmSummarySchema),
})
export type ExperimentSummaryFile = z.infer<typeof ExperimentSummaryFileSchema>

/** `status.json`: live progress, rewritten after every logged run and by `exp score`. */
export const ExperimentStatusFileSchema = z.object({
  status: z.enum(['running', 'scored', 'verdict']),
  round: num,
  armsDone: count,
  /** Executions (cases x repeats), not distinct cases. */
  casesDone: count,
  casesPlanned: count.nullable(),
  updated: z.string(),
})
export type ExperimentStatusFile = z.infer<typeof ExperimentStatusFileSchema>

/** One side of the list headline: an arm's primary quality rate. */
export const HeadlineSideSchema = z.object({
  arm: z.string(),
  label: z.string(),
  metric: QualityMetricSchema,
})
export type HeadlineSide = z.infer<typeof HeadlineSideSchema>
export const ExperimentRowSchema = z.object({
  id: ExperimentIdSchema,
  /** `yyyy-mm-dd` from the folder name; null when the name carries none. */
  date: z.string().nullable(),
  title: z.string(),
  status: ExperimentStatusSchema,
  progress: z.object({ done: count, planned: count.nullable() }).nullable(),
  round: z.string().nullable(),
  arms: count.nullable(),
  /** Control against the best other arm on the primary metric; null without summary.json. */
  headline: z
    .object({ control: HeadlineSideSchema.nullable(), best: HeadlineSideSchema.nullable() })
    .nullable(),
  /**
   * Totals over the arms: list USD sums priced arms only (`unpricedArms` counts arms with tokens
   * but no list price); a field is null when no arm contributed. Null without summary.json.
   */
  cost: z
    .object({
      tokens: num.nullable(),
      listUsd: num.nullable(),
      unpricedArms: count,
      billedUsd: num.nullable(),
    })
    .nullable(),
  hasSummary: z.boolean(),
  /** Newest modification of any file the viewer reads (epoch ms). */
  updatedAt: z.number(),
})
export type ExperimentRow = z.infer<typeof ExperimentRowSchema>

export const ExperimentDetailSchema = ExperimentRowSchema.extend({
  question: z.string().nullable(),
  verdict: z.string().nullable(),
  primary: z.string().nullable(),
  /** Parsed summary.json arms; null when the file is missing or invalid. */
  armSummaries: z.array(ArmSummarySchema).nullable(),
  /** results.md, shown when there is no usable summary.json. */
  resultsMarkdown: z.string().nullable(),
  /** Why summary.json could not be used, when it exists but is invalid. */
  summaryError: z.string().nullable(),
})
export type ExperimentDetail = z.infer<typeof ExperimentDetailSchema>

export const ExperimentCaseSchema = z.object({
  case: z.string(),
  split: z.string(),
  repeat: z.number().nullable(),
  /** Compact text of the scored outcome (`pass`, `fail`, or its JSON); null when none. */
  outcome: z.string().nullable(),
  /** Pass/fail when the outcome says so; null when it carries no boolean verdict. */
  passed: z.boolean().nullable(),
  seconds: z.number().nullable(),
  error: z.string().nullable(),
  skipped: z.string().nullable(),
})
export type ExperimentCase = z.infer<typeof ExperimentCaseSchema>

export const ExperimentCasesSchema = z.object({
  file: z.string().nullable(),
  cases: z.array(ExperimentCaseSchema),
  /** Lines that were not valid JSON run lines. */
  invalid: count,
  /** Set when cases were cut at the cap. */
  truncated: z.boolean(),
  /** Why there is no case list (no casesFile, missing file). */
  reason: z.string().nullable(),
})
export type ExperimentCases = z.infer<typeof ExperimentCasesSchema>

export const experimentsInvoke = {
  'experiments.list': { input: z.object({}).strict(), output: z.array(ExperimentRowSchema) },
  'experiments.get': {
    input: z.object({ id: ExperimentIdSchema }).strict(),
    output: ExperimentDetailSchema,
  },
  'experiments.cases': {
    input: z.object({ id: ExperimentIdSchema, arm: ArmIdSchema }).strict(),
    output: ExperimentCasesSchema,
  },
} as const

export const experimentsEvents = {
  /** Experiments whose summary, status, record, results or rounds changed. */
  'experiments.changed': z.object({ ids: z.array(ExperimentIdSchema) }),
} as const
