import * as path from 'node:path'

export const REPO_ROOT = path.resolve(__dirname, '../../../..')
export const APP_DIR = path.join(REPO_ROOT, 'apps/desktop')
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures')
export const EVA_FIXTURE_ROOT = path.join(FIXTURES_DIR, 'eva-root')
export const SESSIONS_FIXTURE_DIR = path.join(FIXTURES_DIR, 'agent/sessions/-fixture')
export const FAKE_OMP = path.join(FIXTURES_DIR, 'fake-omp/fake-omp.mjs')
export const proofDir = (phase: number | string): string =>
  path.join(REPO_ROOT, 'proof', `phase-${phase}`)
