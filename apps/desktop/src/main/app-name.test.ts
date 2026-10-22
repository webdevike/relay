import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { moveLegacyConfig } from './app-name'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cfg-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('moveLegacyConfig', () => {
  it('moves the old folder, contents included, when the new one does not exist', () => {
    const legacy = path.join(root, 'EvaOS Electron')
    const next = path.join(root, 'Relay Desktop')
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'chat.json'), '{"chat_agent":"Eren"}')
    moveLegacyConfig(legacy, next)
    expect(fs.existsSync(legacy)).toBe(false)
    expect(fs.readFileSync(path.join(next, 'chat.json'), 'utf8')).toBe('{"chat_agent":"Eren"}')
  })

  it('never touches either folder once the new one exists', () => {
    const legacy = path.join(root, 'EvaOS Electron')
    const next = path.join(root, 'Relay Desktop')
    fs.mkdirSync(legacy)
    fs.mkdirSync(next)
    fs.writeFileSync(path.join(next, 'chat.json'), 'new')
    moveLegacyConfig(legacy, next)
    expect(fs.existsSync(legacy)).toBe(true)
    expect(fs.readFileSync(path.join(next, 'chat.json'), 'utf8')).toBe('new')
  })

  it('does nothing without a legacy folder', () => {
    const next = path.join(root, 'Relay Desktop')
    moveLegacyConfig(path.join(root, 'missing'), next)
    moveLegacyConfig(null, next)
    expect(fs.existsSync(next)).toBe(false)
  })
})
