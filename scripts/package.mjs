/**
 * 打包分发：生成 <包名>-<版本>-dist.zip。
 *
 * 两种模式：
 *   默认（安装包，给普通用户）：只含运行时必需文件 —— lib/、assets/、
 *     cordis.patch.yml、package.json、文档与常驻启动脚本。不含源码、测试、开发配置。
 *   --dev（开发包，给开发者）：额外包含 src/、tests/、scripts/、tsconfig 等。
 *
 * 用法：
 *   node scripts/package.mjs [输出目录]
 *   node scripts/package.mjs [输出目录] --dev
 *
 * ZIP 由 PowerShell 的 Compress-Archive 生成（格式可靠、跨平台可解压）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const devMode = args.includes('--dev');
const positional = args.filter((a) => !a.startsWith('--'));
const outDir = positional[0] ?? join(root, '..');
const suffix = devMode ? '-dev' : '-dist';
const outFile = join(outDir, `${pkg.name}-${pkg.version}${suffix}.zip`);
const stageRoot = join(outDir, `.${pkg.name}-stage`);
const stageDir = join(stageRoot, pkg.name);

/** 运行时必需（安装包与开发包都含）。 */
const RUNTIME_ENTRIES = [
  'lib',
  'assets',
  'scripts',
  'cordis.patch.yml',
  'package.json',
  'LICENSE',
  'README.md',
  'INSTALL.md',
  'BEGINNER-GUIDE.md',
];

/** 仅开发包包含。 */
const DEV_ENTRIES = [
  'src',
  'tests',
  'scripts',
  'README.en.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'PROVENANCE.md',
  'GITHUB.md',
  'tsconfig.json',
  'vitest.config.ts',
  '.gitignore',
  '.gitattributes',
  '.github',
];

/** 永不分发的本机专用文件。 */
const EXCLUDE_NAMES = new Set([
  'node_modules',
  '.git',
  'dist-types',
  '.vitest',
  'coverage',
  'preview-body.json',
  'tts-test-body.json',
  'tts-verify-body.json',
  'align-reference.mjs',
  'fix-role-weights.mjs',
]);

/** 安装包内 scripts/ 只保留这一项。 */
const INSTALL_SCRIPT_ALLOWLIST = new Set(['start-sovits.bat', 'install.bat', 'install-helper.mjs']);

function copyFiltered(src, dest, allowlist) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (EXCLUDE_NAMES.has(name)) continue;
    if (name.endsWith('.wav') || name.endsWith('.tmp') || name.endsWith('.zip')) continue;
    if (allowlist && !allowlist.has(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyFiltered(from, to, null);
    else cpSync(from, to);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) n += countFiles(abs);
    else n += 1;
  }
  return n;
}

// 构建产物必须存在
for (const required of ['lib/index.js', 'assets/sovits-widget.js']) {
  if (!existsSync(join(root, required))) {
    console.error(`缺少构建产物 ${required}，请先运行 pnpm build`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const entries = devMode ? [...RUNTIME_ENTRIES, ...DEV_ENTRIES] : RUNTIME_ENTRIES;
for (const entry of entries) {
  const abs = join(root, entry);
  if (!existsSync(abs)) continue;
  if (statSync(abs).isDirectory()) {
    const allowlist = entry === 'scripts' && !devMode ? INSTALL_SCRIPT_ALLOWLIST : null;
    copyFiltered(abs, join(stageDir, entry), allowlist);
  } else {
    cpSync(abs, join(stageDir, entry));
  }
}

// 安装包附带常驻启动脚本（独立于 dsh 手动运行服务用）
if (!devMode && !existsSync(join(stageDir, 'scripts/start-sovits.bat'))) {
  const bat = join(root, 'scripts/start-sovits.bat');
  if (existsSync(bat)) {
    mkdirSync(join(stageDir, 'scripts'), { recursive: true });
    cpSync(bat, join(stageDir, 'scripts/start-sovits.bat'));
  }
}

const fileCount = countFiles(stageDir);

if (existsSync(outFile)) rmSync(outFile, { force: true });
const ps = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${stageDir}' -DestinationPath '${outFile}' -CompressionLevel Optimal -Force`,
  ],
  { encoding: 'utf8' },
);
if (ps.status !== 0) {
  console.error('压缩失败:', ps.stderr || ps.stdout);
  process.exit(1);
}
rmSync(stageRoot, { recursive: true, force: true });

const size = statSync(outFile).size;
console.log(`打包完成（${devMode ? '开发包' : '安装包'}）: ${outFile}`);
console.log(`  ${pkg.name} ${pkg.version}  ${(size / 1024).toFixed(1)} KB  ${fileCount} 个文件`);
