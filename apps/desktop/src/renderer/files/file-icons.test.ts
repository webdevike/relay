import { describe, expect, it } from 'vitest'
import { iconId, iconUrl } from './file-icons'

const file = (name: string, light = false): string => iconId({ name, kind: 'file', light })
const dir = (name: string, expanded = false): string => iconId({ name, kind: 'dir', expanded })

describe('iconId', () => {
  it('maps extensions like VS Code', () => {
    expect(file('index.ts')).toBe('typescript')
    expect(file('App.tsx')).toBe('react_ts')
    expect(file('main.rs')).toBe('rust')
    expect(file('notes.md')).toBe('markdown')
    expect(file('style.css')).toBe('css')
  })

  it('prefers the longest dotted extension', () => {
    expect(file('fuzzy.test.ts')).toBe('test-ts')
    expect(file('env.d.ts')).toBe('typescript-def')
  })

  it('exact file names win over extensions, case-insensitively', () => {
    expect(file('package.json')).toBe('nodejs')
    expect(file('README.md')).toBe('readme')
    expect(file('Dockerfile')).toBe('docker')
    expect(file('.gitignore')).toBe('git')
  })

  it('a dotfile resolves through its name after the dot, as VS Code does', () => {
    expect(file('.bashrc')).toBe('console')
    expect(file('.env')).toBe('tune')
    expect(file('.unknownrc')).toBe('file')
  })

  it('falls back to a language id, then the default file icon', () => {
    expect(file('deploy.zsh')).toBe('console')
    expect(file('mystery.qqq')).toBe('file')
  })

  it('folders match by name, open or closed, else the default folder', () => {
    expect(dir('src')).toBe('folder-src')
    expect(dir('src', true)).toBe('folder-src-open')
    expect(dir('node_modules')).toBe('folder-node')
    expect(dir('whatever')).toBe('folder')
    expect(dir('whatever', true)).toBe('folder-open')
  })

  it('uses the light variant when the manifest has one', () => {
    expect(file('template.jinja', true)).toBe('jinja_light')
    expect(file('template.jinja', false)).toBe('jinja')
  })
})

describe('iconUrl', () => {
  it('resolves an svg for a mapped id and for the defaults', () => {
    expect(iconUrl({ name: 'a.ts', kind: 'file' })).toMatch(/typescript\.svg/)
    expect(iconUrl({ name: 'x', kind: 'dir' })).toMatch(/folder\.svg/)
    expect(iconUrl({ name: 'mystery.qqq', kind: 'file' })).toMatch(/file\.svg/)
  })
})
