/**
 * 配置持久化与回滚：
 * - 文件：<dataDir>/sovits/dsh-tts-config.json
 * - 每次写入前把当前文件备份为 dsh-tts-config.json.bak-<ISO时间戳>，
 *   只保留最近 `maxBackups` 份；写入采用「临时文件 + 原子 rename」。
 * - 读取失败（JSON 损坏）时自动回滚到最近一份备份，并记录回滚事件。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseConfig, defaultConfig, type RootConfig } from './config.js';
import { JSONValue } from './types.js';

export interface ConfigStoreEvents {
  /** 配置加载失败后成功回滚到备份时触发。 */
  onRollback?: (from: string, reason: string) => void;
}

export class ConfigStore {
  readonly configDir: string;
  readonly filePath: string;
  private readonly maxBackups: number;
  private readonly events: ConfigStoreEvents;

  constructor(dataDir: string, maxBackups = 5, events: ConfigStoreEvents = {}) {
    this.configDir = join(dataDir, 'sovits');
    this.filePath = join(this.configDir, 'dsh-tts-config.json');
    this.maxBackups = maxBackups;
    this.events = events;
  }

  /** 备份文件按时间倒序。 */
  listBackups(): string[] {
    if (!existsSync(this.configDir)) return [];
    return readdirSync(this.configDir)
      .filter((n) => n.startsWith('dsh-tts-config.json.bak-'))
      .sort()
      .reverse()
      .map((n) => join(this.configDir, n));
  }

  /**
   * 读取配置。首次启动（主文件不存在）返回默认配置；
   * 主文件损坏时依次尝试备份回滚（回滚=用备份内容覆盖主文件）。
   * 全部失败时抛错（绝不静默带病启动）。
   */
  load(): RootConfig {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (primaryError) {
      const code = (primaryError as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 首次启动：无主文件、无备份
        return defaultConfig();
      }
      const backups = this.listBackups();
      for (const backup of backups) {
        try {
          const backupRaw = readFileSync(backup, 'utf8');
          const parsed = parseConfig(JSON.parse(backupRaw) as JSONValue);
          // 回滚主文件
          this.writeAtomic(this.filePath, backupRaw);
          this.events.onRollback?.(backup, String(primaryError));
          return parsed;
        } catch {
          // 继续尝试更早的备份
        }
      }
      throw new Error(`dsh-tts-config.json 无法读取且无可用备份: ${String(primaryError)}`, {
        cause: primaryError,
      });
    }
    try {
      return parseConfig(JSON.parse(raw) as JSONValue);
    } catch (primaryError) {
      const backups = this.listBackups();
      for (const backup of backups) {
        try {
          const backupRaw = readFileSync(backup, 'utf8');
          const parsed = parseConfig(JSON.parse(backupRaw) as JSONValue);
          // 回滚主文件
          this.writeAtomic(this.filePath, backupRaw);
          this.events.onRollback?.(backup, String(primaryError));
          return parsed;
        } catch {
          // 继续尝试更早的备份
        }
      }
      throw new Error(`dsh-tts-config.json 无法解析且无可用备份: ${String(primaryError)}`, {
        cause: primaryError,
      });
    }
  }

  /** 持久化：先备份当前主文件，再原子写入。 */
  save(config: RootConfig): void {
    mkdirSync(this.configDir, { recursive: true });
    const payload = `${JSON.stringify(config, null, 2)}\n`;
    if (existsSync(this.filePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(this.filePath, join(this.configDir, `dsh-tts-config.json.bak-${stamp}`));
    }
    this.writeAtomic(this.filePath, payload);
    this.pruneBackups();
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  }

  private pruneBackups(): void {
    const backups = this.listBackups();
    for (const stale of backups.slice(this.maxBackups)) {
      try {
        const s = statSync(stale);
        if (s.isFile()) unlinkSync(stale);
      } catch {
        // 删除失败不影响主流程
      }
    }
  }
}
