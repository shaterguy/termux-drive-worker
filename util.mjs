import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function sha256(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function readText(file, fallback = null) {
  try { return await fsp.readFile(file, 'utf8'); } catch { return fallback; }
}

export async function readJson(file, fallback = null) {
  const text = await readText(file, null);
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export async function readJsonStrict(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, kind: 'MISSING', error };
    return { ok: false, kind: 'READ_ERROR', error };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, kind: 'INVALID_JSON', error };
  }
}

export function run(file, args, options = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 15000, cwd: options.cwd, env: options.env ?? process.env,
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.code ?? null,
    };
  }
}

export async function fileFact(file) {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const bytes = await fsp.readFile(file);
    return { path: file, size: stat.size, mode: stat.mode & 0o777, sha256: sha256(bytes) };
  } catch { return null; }
}

export async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}
