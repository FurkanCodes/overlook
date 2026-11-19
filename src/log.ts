/**
 * Logging that never touches stdout: in MCP mode stdout carries only protocol
 * messages, and a single stray byte breaks the connection.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { overlookHome } from './config.js';

const MAX_BYTES = 5 * 1024 * 1024;

let toFile = true;
let quiet = false;

export function configureLog(opts: { file?: boolean; quiet?: boolean }): void {
  if (opts.file !== undefined) toFile = opts.file;
  if (opts.quiet !== undefined) quiet = opts.quiet;
}

function logFile(): string {
  return join(overlookHome(), 'logs', 'overlook.log');
}

function writeLine(line: string): void {
  if (!toFile) return;
  try {
    const f = logFile();
    mkdirSync(join(overlookHome(), 'logs'), { recursive: true });
    try {
      if (statSync(f).size > MAX_BYTES) renameSync(f, `${f}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(f, line + '\n');
  } catch {
    /* logging must never crash the process */
  }
}

function emit(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  if (!quiet) process.stderr.write(line + '\n');
  writeLine(line);
}

export const log = {
  info: (msg: string) => emit('info', msg),
  warn: (msg: string) => emit('warn', msg),
  error: (msg: string) => emit('error', msg),
  /** One JSON line per event, file only. */
  event: (data: Record<string, unknown>) => writeLine(JSON.stringify({ at: new Date().toISOString(), ...data })),
};
