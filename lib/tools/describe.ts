/**
 * Reads a tool's parameters out of its schema, in the words the docs use.
 *
 * The schema is the one thing that decides what a tool accepts. The list an
 * agent gets over MCP, the docs page, the rulebook and the sentence a tool
 * answers with after wrong input are all made from it here, so they cannot
 * disagree with each other.
 */
import { z } from 'zod';

export interface ParamDoc {
  name: string;
  /** In JSON terms: "string", "integer", "boolean", "array of strings", or the allowed values. */
  type: string;
  required: boolean;
  /** The value used when the parameter is left out, as JSON. Absent when there is none. */
  default?: string;
  /** For example "1 to 20" or "at most 10 items". Empty when there is no limit. */
  limits: string;
  about: string;
}

export interface JsonProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: { type?: string; maxLength?: number };
}

/** The schema as an agent receives it in the MCP tool list. */
export function jsonSchemaOf(schema: z.ZodObject): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as { properties?: Record<string, JsonProperty> } & Record<string, unknown>;
  // A whole number with no limit of its own is given the largest number JavaScript can count to
  // as its limit. That is noise to an agent, so it is taken out again.
  for (const p of Object.values(json.properties ?? {})) {
    if (p.maximum === Number.MAX_SAFE_INTEGER) delete p.maximum;
    if (p.minimum === Number.MIN_SAFE_INTEGER) delete p.minimum;
  }
  return json;
}

export interface Shape {
  /** Each parameter with its JSON type. */
  properties: Record<string, JsonProperty>;
  /** The parameters that must be given. */
  required: Set<string>;
  /** Each parameter in the words of the docs. */
  docs: Map<string, ParamDoc>;
}

const seen = new WeakMap<z.ZodObject, Shape>();

/** The parameters of a schema, for checking a call against them. Worked out once for each schema. */
export function shapeOf(schema: z.ZodObject): Shape {
  let shape = seen.get(schema);
  if (!shape) {
    const json = jsonSchemaOf(schema) as { properties?: Record<string, JsonProperty>; required?: string[] };
    shape = { properties: json.properties ?? {}, required: new Set(json.required ?? []), docs: new Map(paramsOf(schema).map((p) => [p.name, p])) };
    seen.set(schema, shape);
  }
  return shape;
}

const number = (n: number): string => n.toLocaleString('en-US');

function typeOf(p: JsonProperty): string {
  if (Array.isArray(p.enum)) return `one of ${p.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  if (p.type === 'array') return `array of ${p.items?.type ?? 'value'}s`;
  return p.type ?? 'value';
}

function limitsOf(p: JsonProperty): string {
  if (p.type === 'string' && !Array.isArray(p.enum)) {
    if (p.minLength !== undefined && p.maxLength !== undefined) return `${number(p.minLength)} to ${number(p.maxLength)} characters`;
    if (p.maxLength !== undefined) return `at most ${number(p.maxLength)} characters`;
    return '';
  }
  if (p.type === 'integer' || p.type === 'number') {
    if (p.minimum !== undefined && p.maximum !== undefined) return `${number(p.minimum)} to ${number(p.maximum)}`;
    if (p.minimum !== undefined) return `${number(p.minimum)} or more`;
    if (p.maximum !== undefined) return `at most ${number(p.maximum)}`;
    return '';
  }
  if (p.type === 'array' && p.maxItems !== undefined) return `at most ${number(p.maxItems)} items`;
  return '';
}

export function paramsOf(schema: z.ZodObject): ParamDoc[] {
  const json = jsonSchemaOf(schema) as { properties?: Record<string, JsonProperty>; required?: string[] };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, p]) => ({
    name,
    type: typeOf(p),
    required: required.has(name),
    ...(p.default !== undefined ? { default: JSON.stringify(p.default) } : {}),
    limits: limitsOf(p),
    about: p.description ?? '',
  }));
}

/** What a value of this parameter must be: "integer, 1 to 20". */
export function mustBe(p: ParamDoc): string {
  return [p.type, ...(p.limits ? [p.limits] : [])].join(', ');
}

/** One parameter in a few words: `max_results (integer, 1 to 20, default 8)`. */
export function paramInBrief(p: ParamDoc): string {
  const facts = [p.type, ...(p.required ? ['required'] : []), ...(p.limits ? [p.limits] : []), ...(p.default !== undefined ? [`default ${p.default}`] : [])];
  return `${p.name} (${facts.join(', ')})`;
}

/** Every parameter of a tool in one line. A tool answers with it after wrong input, so the agent need not guess twice. */
export function signatureOf(schema: z.ZodObject): string {
  return paramsOf(schema).map(paramInBrief).join('; ');
}
