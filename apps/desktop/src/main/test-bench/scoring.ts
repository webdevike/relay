import type { BenchRun, BenchScore, BenchCase } from '@evaos/contract'

export function scoreRun(run: BenchRun): BenchScore[] {
  return run.configurations.flatMap((config) =>
    (['all', 'development', 'holdout'] as const).map((split) => {
      const cases = run.cases.filter((c) => split === 'all' || c.split === split)
      const pairs = cases.map((c) => ({ c, j: c.judgments.find((j) => j.configId === config.id)! }))
      const valid = pairs.filter((p) => p.j.status === 'valid' && p.j.answer)
      const attempted = pairs.filter((p) => p.j.status !== 'unattempted').length
      const errors = pairs.filter((p) => p.j.status === 'error').length
      const abstentions = valid.filter(
        (p) => p.j.answer!.decision === 'insufficient-evidence',
      ).length
      const defective = valid.filter((p) => p.c.category === 'defective')
      const clean = valid.filter((p) => p.c.category === 'clean')
      const mismatch = valid.filter((p) => p.c.expected !== p.j.answer!.decision)
      const criticalFalsePasses = valid
        .filter(
          (p) =>
            p.c.severity === 'critical' &&
            p.c.expected === 'fail' &&
            p.j.answer!.decision === 'pass',
        )
        .map((p) => p.c.id)
      const rate = (numerator: number, denominator: number) => ({
        numerator,
        denominator,
        value: denominator === 0 ? null : numerator / denominator,
      })
      const categories = (
        ['clean', 'defective', 'insufficient-evidence', 'adversarial'] as BenchCase['category'][]
      ).map((category) => {
        const planned = pairs.filter((p) => p.c.category === category)
        const evaluated = valid.filter((p) => p.c.category === category)
        return {
          category,
          planned: planned.length,
          valid: evaluated.length,
          infrastructure: planned.filter((p) => p.c.error || p.j.status === 'error').length,
          unattempted: planned.filter((p) => p.j.status === 'unattempted').length,
          mismatches: rate(
            evaluated.filter((p) => p.c.expected !== p.j.answer!.decision).length,
            evaluated.length,
          ),
        }
      })
      const allMatching = run.cases.every((c) => {
        const judgment = c.judgments.find((j) => j.configId === config.id)
        return (
          !c.error &&
          c.evidence !== null &&
          judgment?.status === 'valid' &&
          judgment.answer?.decision === c.expected
        )
      })
      return {
        configId: config.id,
        split,
        planned: cases.length,
        attempted,
        completed: valid.length + errors,
        evaluable: valid.length,
        collectorFailures: cases.filter((c) => c.error).length,
        coverage: rate(valid.length - abstentions, attempted),
        abstentions: rate(abstentions, valid.length),
        infrastructure: rate(errors, attempted),
        falsePasses: rate(
          defective.filter((p) => p.j.answer!.decision === 'pass').length,
          defective.length,
        ),
        detection: rate(
          defective.filter((p) => p.j.answer!.decision === 'fail').length,
          defective.length,
        ),
        falseAlarms: rate(
          clean.filter((p) => p.j.answer!.decision === 'fail').length,
          clean.length,
        ),
        mismatches: rate(mismatch.length, valid.length),
        categories,
        criticalFalsePasses,
        inspect:
          run.status === 'completed' &&
          run.errors.length === 0 &&
          allMatching &&
          criticalFalsePasses.length === 0
            ? ('qualified' as const)
            : ('not-qualified' as const),
      }
    }),
  )
}
