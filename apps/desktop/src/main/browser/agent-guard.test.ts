import { describe, expect, it } from 'vitest'
import { riskOf, totalIn, type ElementInfo, type FormInfo } from './agent-guard'

const form = (over: Partial<FormInfo> = {}): FormInfo => ({
  action: '/checkout',
  method: 'post',
  search: false,
  payment: false,
  password: false,
  submitLabel: '',
  ...over,
})

const el = (label: string, over: Partial<ElementInfo> = {}): ElementInfo => ({
  tag: 'button',
  type: 'button',
  role: '',
  label,
  href: '',
  submits: false,
  form: null,
  editable: false,
  ...over,
})

const PAGE = 'Items (1): $84.99\nShipping: $5.00\nSubtotal: $84.99\nOrder total: $89.99\n'

describe('riskOf', () => {
  it('asks before buying, with the order total, but not for steps toward checkout', () => {
    expect(riskOf(el('Place your order'), undefined, PAGE)).toEqual({
      kind: 'purchase',
      label: 'place your order, $89.99',
    })
    expect(riskOf(el('Buy Now'), undefined, '')).toEqual({ kind: 'purchase', label: 'buy now' })
    expect(riskOf(el('PAY'), undefined, 'Total $12')).toEqual({
      kind: 'purchase',
      label: 'pay, $12',
    })
    expect(riskOf(el('Add to Cart'), undefined, PAGE)).toBeNull()
    expect(riskOf(el('Proceed to checkout'), undefined, PAGE)).toBeNull()
    expect(riskOf(el('Payment methods'), undefined, PAGE)).toBeNull()
  })

  it('asks before sending, submitting and deleting', () => {
    expect(riskOf(el('Send'))).toEqual({ kind: 'send', label: 'send' })
    expect(riskOf(el('Post reply'))).toEqual({ kind: 'send', label: 'post reply' })
    expect(riskOf(el('Delete repository'))).toEqual({ kind: 'delete', label: 'delete repository' })
    expect(riskOf(el('Cancel subscription'))).toEqual({
      kind: 'delete',
      label: 'cancel subscription',
    })
    // Submit asks only when it really submits a form.
    expect(riskOf(el('Submit', { submits: true, form: form() }))).toEqual({
      kind: 'submit',
      label: 'submit',
    })
    expect(riskOf(el('Submit feedback link', { tag: 'a', href: 'https://x.test/f' }))).toBeNull()
    expect(riskOf(el('Sender settings'))).toBeNull()
  })

  it('treats any submit of a card form as a purchase, and never asks for search or sign-in', () => {
    const card = form({ payment: true, submitLabel: 'Continue' })
    expect(riskOf(el('Continue', { submits: true, form: card }), undefined, PAGE)).toEqual({
      kind: 'purchase',
      label: 'continue, $89.99',
    })
    const search = form({ search: true, submitLabel: 'Go' })
    expect(riskOf(el('Go', { submits: true, form: search }))).toBeNull()
    const signIn = form({ password: true, submitLabel: 'Sign in' })
    expect(riskOf(el('Sign in', { submits: true, form: signIn }))).toBeNull()
  })

  it('reads Enter in a field as its form submit button', () => {
    const field = el('', { tag: 'input', type: 'text', editable: true, submits: true })
    expect(
      riskOf({ ...field, form: form({ submitLabel: 'Place order' }) }, undefined, PAGE, true),
    ).toEqual({ kind: 'purchase', label: 'place order, $89.99' })
    expect(
      riskOf(
        { ...field, form: form({ search: true, submitLabel: 'Search' }) },
        undefined,
        '',
        true,
      ),
    ).toBeNull()
    // Enter on a plain button is the button's own click; nothing to read as a form submit here.
    expect(riskOf(el('Place order'), undefined, '', true)).toBeNull()
  })

  it('always asks for a declared intent, as the agent said it', () => {
    expect(riskOf(el('Next'), { kind: 'send', label: 'send the invite to Ana' })).toEqual({
      kind: 'send',
      label: 'send the invite to Ana',
    })
    expect(riskOf(null, { kind: 'delete', label: 'delete 3 drafts' })).toEqual({
      kind: 'delete',
      label: 'delete 3 drafts',
    })
  })
})

describe('totalIn', () => {
  it('prefers the order total over subtotals and line prices', () => {
    expect(totalIn(PAGE)).toBe('$89.99')
    expect(totalIn('Subtotal $10.00')).toBeNull()
    expect(totalIn('Total: 1,204.50 USD')).toBe('1,204.50USD')
    expect(totalIn('nothing here')).toBeNull()
  })
})
