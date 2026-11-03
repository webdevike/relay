import * as path from 'node:path'

export const REPO_ROOT = path.resolve(__dirname, '../../../..')
export const APP_DIR = path.join(REPO_ROOT, 'apps/desktop')
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures')
export const EVA_FIXTURE_ROOT = path.join(FIXTURES_DIR, 'eva-root')
export const SESSIONS_FIXTURE_DIR = path.join(FIXTURES_DIR, 'agent/sessions/-fixture')
export const FAKE_OMP = path.join(FIXTURES_DIR, 'fake-omp/fake-omp.mjs')
export const EVA_P3_TEMPLATE = path.join(FIXTURES_DIR, 'eva-p3')
export const FAKE_GATE = path.join(FIXTURES_DIR, 'fake-gate/fake-gate.mjs')
export const FAKE_JOB_RUN = path.join(FIXTURES_DIR, 'fake-job-run/fake-job-run.mjs')
export const FAKE_CLAUDE_BRIDGE = path.join(FIXTURES_DIR, 'fake-claude-bridge/fake-bridge.mjs')
export const FAKE_HERDR = path.join(FIXTURES_DIR, 'fake-herdr/fake-herdr.mjs')
export const AGENT_P4_TEMPLATE = path.join(FIXTURES_DIR, 'agent-p4')
export const proofDir = (phase: number | string): string =>
  path.join(REPO_ROOT, 'proof', `phase-${phase}`)
