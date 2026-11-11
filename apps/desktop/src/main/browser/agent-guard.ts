/**
 * The guardrail of agent-driven tabs: what an element is (ELEMENT_INFO, run in the page), and
 * whether acting on it buys, sends, submits or deletes something (riskOf, pure). A risky action
 * waits for Isaac's Allow on the page and on the chat's work card (agent-drive.ts).
 *
 * The page scripts below are function sources run through CDP (Runtime.callFunctionOn with the
 * element as `this`, or Runtime.evaluate called with the text), never injected as <script>: a
 * page's CSP and Trusted Types don't apply, and nothing stays behind in its DOM.
 */

/** A form an element submits, as the guardrail needs it. */
export interface FormInfo {
  action: string
  method: string
  /** A search form (role=search, a search field, or an action that searches): never asks. */
  search: boolean
  /** Card number, CVC or expiry fields: its submit is a purchase. */
  payment: boolean
  password: boolean
  /** The label of its submit button, what Enter in one of its fields presses. */
  submitLabel: string
}

/** What an agent acted on: tag, label, link and form. */
export interface ElementInfo {
  tag: string
  type: string
  role: string
  /** What Isaac reads on it: aria-label, text, value or title, whitespace folded. */
  label: string
  href: string
  /** Clicking it (or Enter in it) submits `form`. */
  submits: boolean
  form: FormInfo | null
  /** A text field (Enter in it submits its form, when it has one). */
  editable: boolean
}

/** `function () { ... }` with the element as `this`: its ElementInfo. */
export const ELEMENT_INFO = String(function (this: Element) {
  const fold = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const control =
    this.closest(
      'button, a[href], input, select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], label',
    ) ?? this
  const el = control as HTMLElement & {
    value?: unknown
    type?: string
    form?: HTMLFormElement | null
  }
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? (tag === 'button' ? 'submit' : '')).toLowerCase()
  const role = el.getAttribute('role') ?? ''
  const value = typeof el.value === 'string' && tag === 'input' ? el.value : ''
  const label = fold(
    el.getAttribute('aria-label') ||
      el.innerText ||
      (type === 'submit' || type === 'button' ? value : '') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('placeholder'),
  )
  const editable =
    (tag === 'input' &&
      !['submit', 'button', 'image', 'checkbox', 'radio', 'reset', 'file'].includes(type)) ||
    tag === 'textarea' ||
    el.isContentEditable
  const form: HTMLFormElement | null =
    (el.form as HTMLFormElement | null | undefined) ?? el.closest('form')
  const submits =
    !!form &&
    ((tag === 'button' && type === 'submit') ||
      (tag === 'input' && (type === 'submit' || type === 'image')) ||
      (tag === 'input' && editable))
  let info: {
    action: string
    method: string
    search: boolean
    payment: boolean
    password: boolean
    submitLabel: string
  } | null = null
  if (form) {
    const fields = Array.from(
      form.querySelectorAll('input, select, textarea'),
    ) as HTMLInputElement[]
    const named = (f: HTMLInputElement): string =>
      `${f.name} ${f.id} ${f.getAttribute('autocomplete') ?? ''} ${f.getAttribute('aria-label') ?? ''}`.toLowerCase()
    const action = form.getAttribute('action') ?? ''
    const button = form.querySelector(
      'button:not([type]), button[type=submit], input[type=submit], input[type=image]',
    ) as HTMLElement | null
    info = {
      action,
      method: (form.getAttribute('method') ?? 'get').toLowerCase(),
      search:
        form.getAttribute('role') === 'search' ||
        !!form.closest('[role=search]') ||
        fields.some((f) => f.type === 'search') ||
        /search|[?&/]q=|\/s\b/i.test(action),
      payment: fields.some((f) =>
        /cc-(number|csc|exp)|card.?num|cardnumber|\bcvc\b|\bcvv\b|security.?code/.test(named(f)),
      ),
      password: fields.some((f) => f.type === 'password'),
      submitLabel: button
        ? fold(
            button.getAttribute('aria-label') ||
              button.innerText ||
              (button as HTMLInputElement).value ||
              '',
          )
        : '',
    }
  }
  const link = el.closest('a[href]') as HTMLAnchorElement | null
  return { tag, type, role, label, href: link?.href ?? '', submits, form: info, editable }
})

/**
 * `function (text) { ... }`: the first visible button, link, field, label or role element whose
 * text (or aria-label, value, placeholder) is `text`, else the first that contains it; a label
 * answers its control. Case and whitespace are ignored.
 */
export const FIND_BY_TEXT = String(function (wanted: string) {
  const norm = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const q = norm(wanted)
  const sel =
    'button, a[href], input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [contenteditable=true]'
  const all = Array.from(document.querySelectorAll(sel)) as HTMLElement[]
  const visible = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  const texts = (el: HTMLElement): string[] => [
    norm(el.getAttribute('aria-label')),
    norm(el.innerText),
    norm((el as HTMLInputElement).value),
    norm(el.getAttribute('placeholder')),
    norm(el.getAttribute('title')),
  ]
  const target = (el: HTMLElement): HTMLElement =>
    el.tagName === 'LABEL' ? ((el as HTMLLabelElement).control ?? el) : el
  const shown = all.filter(visible)
  const exact = shown.find((el) => texts(el).includes(q))
  if (exact) return target(exact)
  const partial = shown.find((el) => texts(el).some((t) => t !== '' && t.includes(q)))
  return partial ? target(partial) : null
})

/** A consequential action waiting for Isaac: its kind and how his Allow row says it. */
export interface Risk {
  kind: 'purchase' | 'send' | 'submit' | 'delete'
  /** As in "Penny wants to <label>": `place order, $89.99`. */
  label: string
}

const NOT_YET = /\b(add to (cart|bag|basket)|proceed to checkout|go to checkout|view cart)\b/
const PURCHASE =
  /\b(place (your |my )?order|buy now|buy it now|pay now|purchase|complete (your |my )?(order|purchase|payment)|confirm (and pay|(your |my )?(order|purchase|payment))|submit (order|payment)|subscribe|donate|start (my |your )?(subscription|membership))\b|^(buy|pay|checkout)\b/
const DELETE =
  /\b(delete|discard|erase|cancel (my |your )?(subscription|order|membership|account)|close (my |your )?account|deactivate|remove (my |your )?account)\b/
const SEND = /^(send|post|publish|tweet|reply|share|comment)\b/
const SUBMIT = /^submit\b/

/** An order total on the page (`Order total: $89.99`), for the purchase row; null when none. */
export function totalIn(pageText: string): string | null {
  const money = String.raw`([$€£]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP))`
  for (const name of [
    'order total',
    'grand total',
    'total due',
    'amount due',
    'you pay',
    'total',
  ]) {
    const re = new RegExp(String.raw`(?<!sub)${name}[^\n$€£\d]{0,24}${money}`, 'gi')
    const hits = [...pageText.matchAll(re)]
    const last = hits.at(-1)?.[1]
    if (last) return last.replace(/\s+/g, '')
  }
  return null
}

/** A button label as words in a sentence: `Place Your Order` -> `place your order`; `PayPal` stays. */
const lower = (label: string): string => {
  const t = label.trim().replace(/[.!…]+$/, '')
  if (t === t.toUpperCase()) return t.toLowerCase()
  return t.replace(/\b[A-Z][a-z]*\b/g, (w) => w.toLowerCase())
}

/**
 * Whether acting on `info` needs Isaac's Allow first, and how to say it. A declared intent always
 * asks. Otherwise the element's label decides (Place order, Buy now, Pay, Subscribe; Send, Post,
 * Publish; Submit; Delete, Cancel subscription), and any submit of a form with card fields is a
 * purchase. Add to cart, Proceed to checkout, sign-in and search forms never ask. `pageText`
 * adds the order total to a purchase. `enter`: Enter pressed in `info` (a field): it acts as its
 * form's submit button.
 */
export function riskOf(
  info: ElementInfo | null,
  intent?: { kind: Risk['kind']; label: string },
  pageText = '',
  enter = false,
): Risk | null {
  if (intent) return { kind: intent.kind, label: intent.label }
  if (!info) return null
  if (enter && !(info.editable && info.submits)) return null
  if (info.form?.search && info.submits) return null
  const text = enter ? (info.form?.submitLabel ?? '') : info.label
  const l = text.toLowerCase()
  const withTotal = (label: string): Risk => {
    const total = totalIn(pageText)
    return {
      kind: 'purchase',
      label: total && !label.includes(total) ? `${label}, ${total}` : label,
    }
  }
  if (l.length > 0 && l.length <= 60 && !NOT_YET.test(l)) {
    if (PURCHASE.test(l)) return withTotal(lower(text))
    if (DELETE.test(l)) return { kind: 'delete', label: lower(text) }
    if (SEND.test(l)) return { kind: 'send', label: lower(text) }
    if (SUBMIT.test(l) && info.submits) return { kind: 'submit', label: lower(text) }
  }
  if (info.submits && info.form?.payment) return withTotal(text ? lower(text) : 'submit payment')
  return null
}
