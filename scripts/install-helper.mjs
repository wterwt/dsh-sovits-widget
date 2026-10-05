/**
 * 安装辅助脚本：把插件写入 dsh profile 的 package.json。
 *
 * 由 install.bat 调用，也可单独运行：
 *   node scripts/install-helper.mjs <profile目录> <插件目录>
 *
 * 行为：
 * - 备份 package.json 为 package.json.bak-sovits（已存在则不覆盖）
 * - dependencies 增加 "dsh-sovits-widget": "link:<插件目录>"
 * - dsh.profile.bundles 追加 "dsh-sovits-widget"（去重）
 * - 保留原有字段与顺序，仅做最小改写
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [profileDir, pluginDir] = process.argv.slice(2);

if (!profileDir || !pluginDir) {
  console.error('用法: node scripts/install-helper.mjs <profile目录> <插件目录>');
  process.exit(1);
}

const pkgPath = join(resolve(profileDir), 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`[错误] 找不到 profile 配置: ${pkgPath}`);
  process.exit(1);
}

const pluginPath = resolve(pluginDir).replace(/\\/g, '/');
if (!existsSync(join(resolve(pluginDir), 'cordis.patch.yml'))) {
  console.error(`[错误] 插件目录不完整（缺少 cordis.patch.yml）: ${resolve(pluginDir)}`);
  process.exit(1);
}

// 备份（不覆盖已有备份，保留用户最早的那份）
const backupPath = `${pkgPath}.bak-sovits`;
if (!existsSync(backupPath)) {
  copyFileSync(pkgPath, backupPath);
  console.log(`[备份] ${backupPath}`);
} else {
  console.log('[备份] 已存在 package.json.bak-sovits，跳过（保留最早的备份）');
}

let config;
try {
  config = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error(`[错误] package.json 不是合法 JSON: ${err.message}`);
  process.exit(1);
}

config.dependencies = config.dependencies ?? {};
config.dependencies['dsh-sovits-widget'] = `link:${pluginPath}`;

config.dsh = config.dsh ?? {};
config.dsh.profile = config.dsh.profile ?? {};
config.dsh.profile.bundles = config.dsh.profile.bundles ?? [];
if (!config.dsh.profile.bundles.includes('dsh-sovits-widget')) {
  config.dsh.profile.bundles.push('dsh-sovits-widget');
}

writeFileSync(pkgPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log('[写入] dependencies.dsh-sovits-widget = link:' + pluginPath);
console.log('[写入] dsh.profile.bundles 已包含 dsh-sovits-widget');
console.log('[完成] 配置写入成功');
