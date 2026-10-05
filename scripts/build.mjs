/**
 * 构建脚本：esbuild 产出两个自包含 bundle。
 *
 * - lib/index.js（宿主半面，ESM，Node 平台）：zod 与 p-queue **全部内联**，
 *   使插件在没有任何 node_modules 的情况下也能被加载（开箱即装）。
 * - assets/sovits-widget.js（客户端半面，IIFE，浏览器）：全部内联，
 *   经宿主路由 /dsh-sovits/client.js 下发。
 *
 * 只有 Node 内置模块保持 external（subprocess/fs/path/crypto 等由运行时提供）。
 */

import { build } from 'esbuild';
import { mkdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Node 内置模块（含 node: 前缀形式）不打包。 */
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

async function main() {
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });

  const hostOut = join(root, 'lib/index.js');
  await build({
    entryPoints: [join(root, 'src/host/index.ts')],
    outfile: hostOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: nodeBuiltins,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js: '/* dsh-sovits-widget — 自包含构建，依赖已内联，无需 node_modules。 */',
    },
  });

  const clientOut = join(root, 'assets/sovits-widget.js');
  await build({
    entryPoints: [join(root, 'src/client/index.ts')],
    outfile: clientOut,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome100',
    sourcemap: false,
    legalComments: 'none',
    minify: false,
    logLevel: 'warning',
  });

  const hostKb = (statSync(hostOut).size / 1024).toFixed(1);
  const clientKb = (statSync(clientOut).size / 1024).toFixed(1);
  console.log(`build ok: lib/index.js (${hostKb} KB), assets/sovits-widget.js (${clientKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
