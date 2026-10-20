import { z } from 'zod'

export const BenchId = z.string().uuid()
export const BenchDigest = z.string().regex(/^[a-f0-9]{64}$/)
export const BenchVerdict = z.enum(['pass', 'fail', 'insufficient-evidence'])
export const BenchCategory = z.enum(['clean', 'defective', 'insufficient-evidence', 'adversarial'])
export const BenchSplit = z.enum(['development', 'holdout'])
export const BenchIdentity = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    profile: z.string().min(1).max(100),
  })
  .strict()
export const BenchModelSchema = BenchIdentity.extend({
  label: z.string().max(300),
  resolvedVersion: z.string().max(200).nullable(),
}).strict()
export const BenchLimitsSchema = z
  .object({
    captureMs: z.number().int().positive().max(30_000),
    judgmentMs: z.number().int().positive().max(60_000),
    totalMs: z.number().int().positive().max(3_600_000),
    envelopeBytes: z.number().int().positive().max(32_768),
    rawBytes: z.number().int().positive().max(65_536),
    pngBytes: z.number().int().positive().max(8_388_608),
  })
  .strict()
export const BENCH_LIMITS: z.infer<typeof BenchLimitsSchema> = {
  captureMs: 30_000,
  judgmentMs: 60_000,
  totalMs: 3_600_000,
  envelopeBytes: 32_768,
  rawBytes: 65_536,
  pngBytes: 8_388_608,
}
export const BenchTextSchema = z
  .object({ version: z.string().max(80), text: z.string().max(8_192), hash: BenchDigest })
  .strict()
const rect = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
  .strict()
export const BenchObservationsSchema = z
  .object({
    viewport: z.object({ width: z.number().positive(), height: z.number().positive() }).strict(),
    label: z
      .object({ associated: z.boolean(), text: z.string().max(200) })
      .strict()
      .nullable(),
    clipping: z
      .object({ clipped: z.boolean(), control: rect, text: rect, container: rect })
      .strict()
      .nullable(),
    keyboard: z
      .object({ sequence: z.array(z.enum(['field', 'save', 'body', 'other'])).max(10) })
      .strict()
      .nullable(),
    persistence: z
      .object({
        before: z.string().max(200),
        entered: z.string().max(200),
        afterSave: z.string().max(200),
        afterReload: z.string().max(200),
      })
      .strict()
      .nullable(),
    pageText: z.string().max(2_000),
  })
  .strict()
export const BenchEnvelopeSchema = z
  .object({
    track: z.literal('text-observation'),
    criterion: z.string().min(1).max(1_000),
    rubric: BenchTextSchema,
    skill: BenchTextSchema,
    observations: BenchObservationsSchema,
    missing: z.array(z.enum(['label', 'clipping', 'keyboard', 'persistence'])).max(4),
  })
  .strict()
export const BenchConfigSchema = BenchIdentity.extend({
  id: BenchDigest,
  track: z.literal('text-observation'),
  rubric: BenchTextSchema,
  skill: BenchTextSchema,
  limits: BenchLimitsSchema,
}).strict()
export const BenchAnswerSchema = z
  .object({
    raw: z.string().max(65_536),
    decision: BenchVerdict,
    rationale: z.string().min(1).max(8_192),
    requested: BenchIdentity,
    returned: BenchIdentity.nullable(),
    resolvedVersion: z.string().max(200).nullable(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().nullable(),
        outputTokens: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    cost: z.number().finite().nonnegative().nullable(),
  })
  .strict()
export const BenchErrorSchema = z
  .object({
    code: z.enum([
      'collector',
      'provider',
      'timeout',
      'cancelled',
      'invalid-answer',
      'storage',
      'interrupted',
      'limit',
    ]),
    message: z.string().max(500),
    caseId: BenchId.nullable(),
    configId: BenchDigest.nullable(),
  })
  .strict()
export const BenchEvidenceSchema = z
  .object({
    id: BenchId,
    envelope: BenchEnvelopeSchema,
    digest: BenchDigest,
    beforeId: BenchId,
    afterId: BenchId,
    beforeDigest: BenchDigest,
    afterDigest: BenchDigest,
    collectedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
  })
  .strict()
export const BenchJudgmentSchema = z
  .object({
    configId: BenchDigest,
    status: z.enum(['unattempted', 'started', 'valid', 'error']),
    startedAt: z.string().datetime().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    answer: BenchAnswerSchema.nullable(),
    error: BenchErrorSchema.nullable(),
  })
  .strict()
export const BenchCaseSchema = z
  .object({
    id: BenchId,
    category: BenchCategory,
    split: BenchSplit,
    expected: BenchVerdict,
    severity: z.enum(['normal', 'critical']),
    evidence: BenchEvidenceSchema.nullable(),
    error: BenchErrorSchema.nullable(),
    judgments: z.array(BenchJudgmentSchema).max(4),
  })
  .strict()
const rate = z
  .object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    value: z.number().nullable(),
  })
  .strict()
const categoryScore = z
  .object({
    category: BenchCategory,
    planned: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    infrastructure: z.number().int().nonnegative(),
    unattempted: z.number().int().nonnegative(),
    mismatches: rate,
  })
  .strict()
export const BenchScoreSchema = z
  .object({
    configId: BenchDigest,
    split: z.enum(['development', 'holdout', 'all']),
    planned: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    evaluable: z.number().int().nonnegative(),
    collectorFailures: z.number().int().nonnegative(),
    coverage: rate,
    abstentions: rate,
    infrastructure: rate,
    falsePasses: rate,
    detection: rate,
    falseAlarms: rate,
    mismatches: rate,
    categories: z.array(categoryScore).length(4),
    criticalFalsePasses: z.array(BenchId).max(24),
    inspect: z.enum(['qualified', 'not-qualified']),
  })
  .strict()
export const BenchRunSchema = z
  .object({
    version: z.literal(1),
    id: BenchId,
    status: z.enum(['running', 'completed', 'cancelled', 'error', 'interrupted']),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    fixtureVersion: z.string().max(80),
    fixtureHash: BenchDigest,
    configurations: z.array(BenchConfigSchema).min(2).max(4),
    cases: z.array(BenchCaseSchema).length(24),
    errors: z.array(BenchErrorSchema).max(200),
    scores: z.array(BenchScoreSchema).max(12),
  })
  .strict()
export const BenchStartSchema = z
  .object({
    configurations: z.array(BenchIdentity).min(2).max(4),
    limits: BenchLimitsSchema.optional(),
  })
  .strict()
export const BenchProgressSchema = z
  .object({
    runId: BenchId,
    status: BenchRunSchema.shape.status,
    planned: z.number().int(),
    completed: z.number().int(),
    caseId: BenchId.nullable(),
    configId: BenchDigest.nullable(),
  })
  .strict()
export type BenchIdentity = z.infer<typeof BenchIdentity>
export type BenchModel = z.infer<typeof BenchModelSchema>
export type BenchLimits = z.infer<typeof BenchLimitsSchema>
export type BenchEnvelope = z.infer<typeof BenchEnvelopeSchema>
export type BenchConfig = z.infer<typeof BenchConfigSchema>
export type BenchAnswer = z.infer<typeof BenchAnswerSchema>
export type BenchRun = z.infer<typeof BenchRunSchema>
export type BenchCase = z.infer<typeof BenchCaseSchema>
export type BenchError = z.infer<typeof BenchErrorSchema>
export type BenchStart = z.infer<typeof BenchStartSchema>
export type BenchProgress = z.infer<typeof BenchProgressSchema>
export type BenchScore = z.infer<typeof BenchScoreSchema>
export const testBenchInvoke = {
  'testBench.models': { input: z.object({}).strict(), output: z.array(BenchModelSchema) },
  'testBench.start': { input: BenchStartSchema, output: z.object({ runId: BenchId }) },
  'testBench.cancel': {
    input: z.object({ runId: BenchId }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  'testBench.list': { input: z.object({}).strict(), output: z.array(BenchRunSchema) },
  'testBench.get': { input: z.object({ runId: BenchId }).strict(), output: BenchRunSchema },
  'testBench.evidence': {
    input: z.object({ runId: BenchId, evidenceId: BenchId }).strict(),
    output: z.object({ dataUrl: z.string().max(11_184_840) }),
  },
}
export const testBenchEvents = { 'testBench.progress': BenchProgressSchema }
