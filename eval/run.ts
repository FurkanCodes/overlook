/**
 * Eval runner: drives a model through Overlook's tools over any
 * OpenAI-compatible chat-completions endpoint (Ollama, OpenRouter, OpenAI,
 * llama.cpp server) and scores whether the saved dashboards show the right
 * numbers.
 *
 *   node dist/eval/run.js --dry                       check the prompts only
 *   OVERLOOK_EVAL_MODEL=qwen3-coder:30b node dist/eval/run.js
 *
 * With Ollama, start the server with OLLAMA_CONTEXT_LENGTH=32768: the
 * OpenAI-compatible endpoint cannot set the context size per request.
 *
 * Env: OVERLOOK_EVAL_BASE_URL (default http://localhost:11434/v1),
 *      OVERLOOK_EVAL_MODEL, OVERLOOK_EVAL_API_KEY, OVERLOOK_EVAL_RUNS (3),
 *      OVERLOOK_EVAL_TEMPERATURE (0.3).
 * The tools run through the same handlers the MCP server uses, so the score
 * reflects Overlook's design, not a harness.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Check {
  types: string[];
  check_sql: string;
}
interface Prompt {
  id: string;
  instruction: string;
  checks: Check[];
  start?: string;
  keep_ids?: string[];
  needs_filter?: string;
}
interface PromptFile {
  prompts: Prompt[];
  starts: Record<string, unknown>;
}

const root = join(import.meta.dirname, '..', '..');
const file = JSON.parse(readFileSync(join(root, 'eval', 'prompts.json'), 'utf8')) as PromptFile;
const dataDir = join(root, 'examples', 'data').replaceAll('\\', '/');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const baseUrl = (process.env.OVERLOOK_EVAL_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const model = process.env.OVERLOOK_EVAL_MODEL ?? '';
const runs = Number(process.env.OVERLOOK_EVAL_RUNS ?? 3);
const temperature = Number(process.env.OVERLOOK_EVAL_TEMPERATURE ?? 0.3);
const MAX_TURNS = 24;
const MAX_SAVES = 3;

/** A fresh OVERLOOK_HOME per run, with the example sources registered. */
async function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'overlook-eval-'));
  process.env.OVERLOOK_HOME = home;
  process.env.OVERLOOK_NO_SERVE = '1';
  mkdirSync(join(home, 'dashboards'), { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ version: 1, sources: { orders: { type: 'file', path: `${dataDir}/orders.csv` }, traffic: { type: 'file', path: `${dataDir}/traffic.csv` } } }),
  );
  const { EngineHolder } = await import('../src/engine/engine.js');
  const engines = new EngineHolder();
  return { home, engines, cleanup: () => { engines.close(); rmSync(home, { recursive: true, force: true }); } };
}

/** Rows as sorted, rounded tuples, ignoring column names and row order. */
function canon(rows: Record<string, unknown>[], cols?: string[]): string[] {
  return rows
    .map((r) =>
      (cols ?? Object.keys(r))
        .map((c) => {
          const v = r[c];
          if (typeof v === 'number') return (Math.round(v * 1e6) / 1e6).toString();
          return String(v);
        })
        .join('\u0001'),
    )
    .sort();
}

function sameRows(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The panel columns that carry the values a check compares: x then y, or value. */
function panelCols(p: Record<string, unknown>): string[] | undefined {
  if (p.type === 'kpi') return [String(p.value)];
  if (p.type === 'table') return undefined;
  const ys = Array.isArray(p.y) ? p.y.map(String) : [String(p.y)];
  return [String(p.x), ...(p.series ? [String(p.series)] : []), ...ys];
}

async function score(prompt: Prompt, home: string, engine: Awaited<ReturnType<InstanceType<typeof import('../src/engine/engine.js').EngineHolder>['get']>>, slug: string) {
  const { loadRaw } = await import('../src/store.js');
  const { filterDefaults } = await import('../src/check.js');
  const spec = loadRaw(slug) as { panels?: Record<string, unknown>[]; filters?: { id: string }[] } | undefined;
  if (!spec?.panels) return { ok: false, why: 'no dashboard saved' };
  if (prompt.keep_ids) {
    const ids = new Set(spec.panels.map((p) => p.id));
    const lost = prompt.keep_ids.filter((id) => !ids.has(id));
    if (lost.length) return { ok: false, why: `panels removed: ${lost.join(', ')}` };
  }
  if (prompt.needs_filter && !(spec.filters ?? []).some((f) => f.id === prompt.needs_filter)) return { ok: false, why: `no "${prompt.needs_filter}" filter` };
  const params = filterDefaults(spec.filters as never);
  for (const check of prompt.checks) {
    const want = await engine.run(check.check_sql, {}, { limit: 5000 });
    const wantRows = canon(want.rows);
    let matched = false;
    for (const p of spec.panels) {
      if (!check.types.includes(String(p.type)) || typeof p.sql !== 'string') continue;
      const got = await engine.run(p.sql, params, { limit: 5000 }).catch(() => undefined);
      if (!got) continue;
      const cols = panelCols(p);
      const gotRows = canon(got.rows, cols && cols.length === want.columns.length ? cols : undefined);
      if (sameRows(gotRows, wantRows)) {
        matched = true;
        break;
      }
    }
    if (!matched) return { ok: false, why: `no ${check.types.join('/')} panel matches: ${check.check_sql}` };
  }
  void home;
  return { ok: true, why: '' };
}

/** The exact tool definitions the MCP server registers. */
const { toolJsonSchemas } = await import('../src/mcp/tools.js');
const TOOLS = toolJsonSchemas();

interface Msg {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

async function chat(messages: Msg[], seed: number): Promise<Msg> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.OVERLOOK_EVAL_API_KEY ? { authorization: `Bearer ${process.env.OVERLOOK_EVAL_API_KEY}` } : {}) },
    body: JSON.stringify({ model, messages, tools: TOOLS, temperature, seed }),
  });
  if (!res.ok) throw new Error(`model endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: Msg }[] };
  return body.choices[0]!.message;
}

async function runOnce(prompt: Prompt, seed: number) {
  const { home, engines, cleanup } = await freshHome();
  const { createTools } = await import('../src/mcp/tools.js');
  const { saveDashboard } = await import('../src/store.js');
  try {
    if (prompt.start) saveDashboard('start', file.starts[prompt.start] as never);
    const tools = createTools(engines) as unknown as Record<string, (a: unknown) => Promise<{ text: string; isError?: boolean }>>;
    const messages: Msg[] = [
      { role: 'system', content: 'You build dashboards with the Overlook tools. Use the tools; do not ask the user questions. Finish when the dashboard is saved.' },
      { role: 'user', content: prompt.instruction },
    ];
    let saves = 0;
    let savedSlug: string | undefined;
    let tokens = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const msg = await chat(messages, seed);
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
      tokens += JSON.stringify(msg).length / 4;
      if (!msg.tool_calls?.length) break;
      for (const call of msg.tool_calls) {
        let a: Record<string, unknown> = {};
        try {
          a = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* the tool reports bad input */
        }
        const fn = tools[call.function.name];
        let out = fn ? await fn(a) : { text: `unknown tool ${call.function.name}`, isError: true };
        if (call.function.name === 'save_dashboard') {
          saves++;
          if (!out.isError) {
            const { slugify } = await import('../src/store.js');
            savedSlug = slugify(String(a.name ?? ''));
          } else if (saves >= MAX_SAVES) {
            out = { text: `${out.text}\n(out of tries)`, isError: true };
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
      }
      if (savedSlug || saves >= MAX_SAVES) break;
    }
    if (!savedSlug) return { ok: false, why: `not saved after ${saves} tries`, saves, tokens };
    const engine = await engines.get();
    const s = await score(prompt, home, engine, savedSlug);
    return { ...s, saves, tokens: Math.round(tokens) };
  } finally {
    cleanup();
  }
}

async function main() {
  const prompts = file.prompts.filter((p) => !only || p.id === only);
  if (dry) {
    const { home, engines, cleanup } = await freshHome();
    const engine = await engines.get();
    const { checkDashboard } = await import('../src/check.js');
    let bad = 0;
    for (const p of prompts) {
      for (const c of p.checks) {
        try {
          const r = await engine.run(c.check_sql, {}, { limit: 5000 });
          console.log(`ok   ${p.id}: ${r.rows.length} rows`);
        } catch (e) {
          bad++;
          console.log(`FAIL ${p.id}: ${(e as Error).message}`);
        }
      }
    }
    for (const [name, spec] of Object.entries(file.starts)) {
      const r = await checkDashboard(spec, engine);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} start ${name}`);
      if (!r.ok) bad++;
    }
    cleanup();
    void home;
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (!model) {
    console.error('Set OVERLOOK_EVAL_MODEL (for example qwen3-coder:30b) or run with --dry.');
    process.exit(2);
  }
  const results: { id: string; runs: { ok: boolean; why: string; saves: number }[]; pass: boolean }[] = [];
  for (const p of prompts) {
    const rs = [];
    for (let i = 0; i < runs; i++) {
      try {
        rs.push(await runOnce(p, 1000 + i));
      } catch (e) {
        rs.push({ ok: false, why: (e as Error).message, saves: 0 });
      }
    }
    const passed = rs.filter((r) => r.ok).length;
    const pass = passed >= Math.ceil((runs * 2) / 3);
    results.push({ id: p.id, runs: rs, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${p.id.padEnd(20)} ${passed}/${runs}${pass ? '' : `  ${rs.find((r) => !r.ok)?.why ?? ''}`}`);
  }
  const total = results.filter((r) => r.pass).length;
  console.log(`\n${model}: ${total}/${results.length} prompts passed (${runs} runs each, temperature ${temperature})`);
  const outDir = join(root, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${model.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify({ model, temperature, runs, total, results }, null, 2));
  console.log(`wrote ${out}`);
}

await main();
