import { Schema } from "effect"

/**
 * The field types a config file writes, compiled to Effect Schema:
 * - `"string"`, `"nonEmptyString"`, `"number"`, `"int"`, `"boolean"`, `"json"`
 * - `{"enum": ["phone", "desktop"]}`: one of these literals
 * - `{"array": <type>}`
 * - any other object: a struct of these types; a key ending in `?` is optional (`"data?": "json"`)
 */
export interface Fields {
  readonly schema: Schema.Codec<unknown>
  /** Every field name, and whether it is required. */
  readonly fields: ReadonlyMap<string, { readonly required: boolean }>
}

const BASE: Readonly<Record<string, Schema.Top>> = {
  string: Schema.String,
  nonEmptyString: Schema.NonEmptyString,
  number: Schema.Number,
  int: Schema.Int,
  boolean: Schema.Boolean,
  json: Schema.Json
}

const HINT = `use ${Object.keys(BASE).join(", ")}, {"enum": [...]}, {"array": <type>} or an object of fields`

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

type Compiled = { readonly ok: true; readonly schema: Schema.Top } | { readonly ok: false; readonly errors: ReadonlyArray<string> }

const compileType = (spec: unknown, at: string): Compiled => {
  if (typeof spec === "string") {
    const base = BASE[spec]
    return base === undefined ? { ok: false, errors: [`${at}: unknown type ${JSON.stringify(spec)} (${HINT})`] } : { ok: true, schema: base }
  }
  if (!isObject(spec)) return { ok: false, errors: [`${at}: ${JSON.stringify(spec)} is not a type (${HINT})`] }
  const keys = Object.keys(spec)
  if (keys.length === 1 && keys[0] === "enum") {
    const values = spec["enum"]
    if (!Array.isArray(values) || values.length === 0 || !values.every((value) => ["string", "number", "boolean"].includes(typeof value))) {
      return { ok: false, errors: [`${at}.enum: a non-empty list of strings, numbers or booleans`] }
    }
    return { ok: true, schema: Schema.Literals(values as ReadonlyArray<string | number | boolean>) }
  }
  if (keys.length === 1 && keys[0] === "array") {
    const item = compileType(spec["array"], `${at}.array`)
    return item.ok ? { ok: true, schema: Schema.Array(item.schema) } : item
  }
  const struct = compileStruct(spec, at)
  return struct.ok ? { ok: true, schema: struct.fields.schema } : struct
}

const compileStruct = (
  spec: Readonly<Record<string, unknown>>,
  at: string
): { readonly ok: true; readonly fields: Fields } | { readonly ok: false; readonly errors: ReadonlyArray<string> } => {
  const errors: Array<string> = []
  const schemas: Record<string, Schema.Top> = {}
  const fields = new Map<string, { readonly required: boolean }>()
  for (const [key, value] of Object.entries(spec)) {
    const optional = key.endsWith("?")
    const name = optional ? key.slice(0, -1) : key
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`${at}: bad field name ${JSON.stringify(key)}`)
      continue
    }
    const compiled = compileType(value, `${at}.${name}`)
    if (!compiled.ok) {
      errors.push(...compiled.errors)
      continue
    }
    schemas[name] = optional ? Schema.optionalKey(compiled.schema) : compiled.schema
    fields.set(name, { required: !optional })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, fields: { schema: Schema.Struct(schemas) as unknown as Schema.Codec<unknown>, fields } }
}

/** An event's (or an input's, or an answer's) data: always an object of fields. */
export const compileFields = (spec: unknown, at: string) =>
  isObject(spec) ? compileStruct(spec, at) : { ok: false as const, errors: [`${at}: an object of fields (${HINT})`] }

/** A schema typed in code (`Schema.Struct`, a domain's `schema.ts`) as `Fields`: an agent refers to it by its registered name. */
export const fromStruct = (struct: Schema.Struct<Schema.Struct.Fields>): Fields => ({
  schema: struct as unknown as Schema.Codec<unknown>,
  fields: new Map(Object.entries(struct.fields).map(([name, field]) => [name, { required: field.ast.context?.isOptional !== true }]))
})
