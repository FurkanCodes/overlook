import type { z } from 'zod';

/** One problem with a dashboard spec, written for a model to act on. */
export interface SpecError {
  /** JSON path into the spec, e.g. `panels[2].y`. Empty for whole-spec errors. */
  path: string;
  message: string;
  /** A one-line suggestion for how to fix it. */
  fix?: string;
}

export interface SpecWarning {
  path: string;
  message: string;
}

export interface SpecRepair {
  path: string;
  from: unknown;
  to: unknown;
  reason: string;
}

export function formatPath(parts: readonly PropertyKey[]): string {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

export function joinPath(prefix: string, rest: string): string {
  if (!prefix) return rest;
  if (!rest) return prefix;
  return rest.startsWith('[') ? prefix + rest : `${prefix}.${rest}`;
}

function describeValue(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return v.length > 40 ? `a string ("${v.slice(0, 37)}...")` : `"${v}"`;
  return typeof v === 'object' ? 'an object' : `${typeof v} ${String(v)}`;
}

function getAt(root: unknown, parts: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[p];
  }
  return cur;
}

/** Turn zod issues into short, model-friendly errors. */
export function fromZodIssues(issues: readonly z.core.$ZodIssue[], input: unknown, prefix = ''): SpecError[] {
  const out: SpecError[] = [];
  for (const issue of issues) {
    const path = joinPath(prefix, formatPath(issue.path));
    const received = getAt(input, issue.path);
    switch (issue.code) {
      case 'invalid_type': {
        if (received === undefined) {
          out.push({ path, message: `required field is missing (expected ${issue.expected})`, fix: `add "${String(issue.path.at(-1) ?? 'value')}"` });
        } else {
          out.push({ path, message: `expected ${issue.expected}, received ${describeValue(received)}` });
        }
        break;
      }
      case 'invalid_value': {
        const allowed = issue.values.map((v) => JSON.stringify(v)).join(', ');
        out.push({
          path,
          message: `${describeValue(received)} is not allowed`,
          fix: `use one of: ${allowed}`,
        });
        break;
      }
      case 'invalid_union': {
        out.push({ path, message: `${describeValue(received)} does not match any allowed form`, fix: 'use a column name string, or an array of column names' });
        break;
      }
      case 'too_small':
      case 'too_big': {
        const n = Array.isArray(received) ? `${received.length} items` : typeof received === 'string' ? `${received.length} characters` : describeValue(received);
        out.push({ path, message: `${issue.message} (received ${n})` });
        break;
      }
      case 'invalid_format':
        out.push({ path, message: `${describeValue(received)}: ${issue.message}`, fix: 'use letters, digits and _ only, starting with a letter, e.g. "revenue_by_month"' });
        break;
      default:
        out.push({ path, message: issue.message });
    }
  }
  return out;
}

/** Levenshtein edit distance, case-insensitive. */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * The column `name` refers to when it differs only in letter case
 * (`Revenue` → `revenue`), or undefined. Any other difference is reported as
 * an error with suggestions instead of being guessed, so a repair can never
 * change which numbers a chart shows.
 */
export function caseOnlyMatch(name: string, candidates: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  const hits = candidates.filter((c) => c.toLowerCase() === lower);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Up to `n` candidates sorted by closeness, for "did you mean" lists. */
export function suggestions(name: string, candidates: readonly string[], n = 3): string[] {
  return [...candidates]
    .map((c) => ({ c, d: editDistance(name, c) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .filter((x) => x.d <= Math.max(3, Math.floor(name.length / 2)))
    .map((x) => x.c);
}

export const MAX_ERRORS = 8;

/** Plain-text rendering of a check result's problems, for tool replies. */
export function formatErrors(errors: readonly SpecError[], total = errors.length): string {
  const lines = errors.slice(0, MAX_ERRORS).map((e, i) => {
    const where = e.path ? `${e.path}: ` : '';
    return `${i + 1}. ${where}${e.message}${e.fix ? `\n   fix: ${e.fix}` : ''}`;
  });
  if (total > MAX_ERRORS) lines.push(`(${total - MAX_ERRORS} more errors not shown; fix these first)`);
  return lines.join('\n');
}
