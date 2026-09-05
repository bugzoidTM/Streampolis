#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = path.join(root, 'packages/client/test');
const entries = (await readdir(tests)).filter((name) => name.endsWith('.test.ts'));
const cache = path.join(root, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const output = await mkdtemp(path.join(cache, 'avatar-motion-'));
try {
  await build({
    entryPoints: entries.map((name) => path.join(tests, name)),
    outdir: output, outExtension: { '.js': '.mjs' },
    platform: 'node', target: 'node22', format: 'esm', bundle: true, packages: 'external',
  });
  const result = spawnSync(process.execPath, [
    '--test', ...entries.map((name) => path.join(output, name.replace(/\.ts$/, '.mjs'))),
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const relative = path.relative(cache, output);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('avatar-motion-')) {
    await rm(output, { recursive: true, force: true });
  }
}
