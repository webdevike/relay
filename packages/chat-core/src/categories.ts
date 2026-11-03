import { OTHER_WORKSPACE, workspaceNames, workspaceOf } from './workspaces'

export interface CategoryPrefs {
  chat_categories: string[]
  chat_group_order: string[]
  chat_assignments: Record<string, string>
}

const EXISTS = 'A category with that name already exists.'

type Result = { ok: true } | { ok: false; error: string }

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Which group a chat lists under: the workspace its title names, unless the user moved it.
 * Ported from the Rust app's chat_groups.rs, plus the category editing the app writes to chat.json.
 */
export class Categories {
  private constructor(
    private custom: string[],
    private order: string[],
    private assigned: Record<string, string>,
  ) {}

  static fromPrefs(p: Partial<CategoryPrefs> | null | undefined): Categories {
    const src: Partial<Record<keyof CategoryPrefs, unknown>> = p && typeof p === 'object' ? p : {}
    const raw = src.chat_assignments
    const assigned: Record<string, string> = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, name] of Object.entries(raw)) {
        if (typeof name === 'string') assigned[id] = name
      }
    }
    return new Categories(strings(src.chat_categories), strings(src.chat_group_order), assigned)
  }

  toPrefs(): CategoryPrefs {
    return {
      chat_categories: [...this.custom],
      chat_group_order: [...this.order],
      chat_assignments: { ...this.assigned },
    }
  }

  /** Whether `name` is a category: a workspace, Other, or one of the user's own. */
  exists(name: string): boolean {
    return workspaceNames().includes(name) || this.custom.includes(name)
  }

  /**
   * Where a chat goes (native chat_groups.rs category_of): where it was moved while that category
   * exists, else the workspace its title names, else the one its work points at (`workedIn`).
   */
  categoryOf(id: string, title: string, workedIn: string | null): string {
    const name = Object.hasOwn(this.assigned, id) ? this.assigned[id] : undefined
    if (name !== undefined && this.exists(name)) return name
    const named = workspaceOf(title)
    return named === OTHER_WORKSPACE && workedIn !== null ? workedIn : named
  }

  /** Every category in display order: saved order, then custom, then workspaces. */
  names(): string[] {
    const out: string[] = []
    const push = (n: string) => {
      if (!out.includes(n)) out.push(n)
    }
    for (const n of this.order) if (this.exists(n)) push(n)
    for (const n of this.custom) push(n)
    for (const n of workspaceNames()) push(n)
    return out
  }

  rank(name: string): number {
    const i = this.names().indexOf(name)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }

  isCustom(name: string): boolean {
    return this.custom.includes(name)
  }

  add(name: string): Result {
    const n = name.trim()
    if (!n) return { ok: false, error: 'Give the category a name.' }
    const lower = n.toLowerCase()
    if (this.names().some((x) => x.toLowerCase() === lower)) {
      return { ok: false, error: EXISTS }
    }
    this.custom.push(n)
    this.order.unshift(n)
    return { ok: true }
  }

  rename(from: string, to: string): Result {
    if (!this.isCustom(from))
      return { ok: false, error: 'Only your own categories can be renamed.' }
    const n = to.trim()
    if (!n) return { ok: false, error: 'Give the category a name.' }
    const lower = n.toLowerCase()
    if (n !== from && this.names().some((x) => x.toLowerCase() === lower)) {
      return { ok: false, error: EXISTS }
    }
    this.custom = this.custom.map((x) => (x === from ? n : x))
    this.order = this.order.map((x) => (x === from ? n : x))
    for (const id of Object.keys(this.assigned)) {
      if (this.assigned[id] === from) this.assigned[id] = n
    }
    return { ok: true }
  }

  remove(name: string): void {
    this.custom = this.custom.filter((x) => x !== name)
    this.order = this.order.filter((x) => x !== name)
    for (const id of Object.keys(this.assigned)) {
      if (this.assigned[id] === name) delete this.assigned[id]
    }
  }

  assign(id: string, name: string | null): void {
    if (name === null) delete this.assigned[id]
    else this.assigned[id] = name
  }
}

export { OTHER_WORKSPACE }
