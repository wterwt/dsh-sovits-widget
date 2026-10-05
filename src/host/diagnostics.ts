/**
 * 诊断日志（Diagnostics）：内存环形缓冲，记录 API 耗时、文本切分、
 * 报错与健康状态，支持导出为 JSON 文件（“导出 TTS 诊断日志”）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiagnosticsEntry, JSONValue } from './types.js';

export class Diagnostics {
  private readonly ring: DiagnosticsEntry[] = [];
  private readonly ringSize: number;
  private seq = 0;

  constructor(ringSize = 500) {
    this.ringSize = Math.max(10, ringSize);
  }

  /** 记录一条日志。 */
  log(level: DiagnosticsEntry['level'], event: string, message: string, data?: Record<string, JSONValue>): void {
    const entry: DiagnosticsEntry = {
      ts: Date.now(),
      level,
      event,
      message,
      ...(data ? { data } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    this.seq += 1;
  }

  info(event: string, message: string, data?: Record<string, JSONValue>): void {
    this.log('info', event, message, data);
  }

  warn(event: string, message: string, data?: Record<string, JSONValue>): void {
    this.log('warn', event, message, data);
  }

  error(event: string, message: string, data?: Record<string, JSONValue>): void {
    this.log('error', event, message, data);
  }

  /** 导出全部条目（时间正序）。 */
  entries(): DiagnosticsEntry[] {
    return [...this.ring];
  }

  /** 导出到文件，返回路径。 */
  exportToFile(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const name = `dsh-sovits-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const path = join(dir, name);
    appendFileSync(path, `${JSON.stringify({ exportedAt: Date.now(), entries: this.ring }, null, 2)}\n`, 'utf8');
    return path;
  }
}
