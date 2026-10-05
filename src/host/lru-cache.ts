/**
 * 磁盘 LRU 合成缓存：
 * - 键：sha256(JSON.stringify({roleId, text, ttsParams}))（spec: hash(roleId+text+ttsParams)）
 * - 存储：<dir>/<key>.wav（音频）+ <dir>/<key>.json（元数据：mime/lastUsed）
 * - 淘汰：总量超过 maxBytes 时按 lastUsed 从旧到新删除（LRU），
 *   初始化时扫描目录，孤儿/损坏文件一并清理。
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { TtsParams } from './types.js';

interface CacheMeta {
  mime: string;
  lastUsed: number;
  bytes: number;
  /** 音频采样率（合成时解析得到）。 */
  sampleRate: number;
}

/** 生成缓存键。 */
export function cacheKey(roleId: string, text: string, params: TtsParams): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ roleId, text, ttsParams: params }));
  return hash.digest('hex');
}

export class LruAudioCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private totalBytes = 0;
  /** key -> meta（内存索引）。 */
  private readonly index = new Map<string, CacheMeta>();

  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    mkdirSync(dir, { recursive: true });
    this.scan();
  }

  /** 读取命中缓存；命中时更新 lastUsed。 */
  get(key: string): { audio: Buffer; mime: string; sampleRate: number } | null {
    const meta = this.index.get(key);
    if (!meta) return null;
    const audioPath = this.audioPath(key);
    const metaPath = this.metaPath(key);
    try {
      const audio = readFileSync(audioPath);
      meta.lastUsed = Date.now();
      writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
      return { audio, mime: meta.mime, sampleRate: meta.sampleRate };
    } catch {
      // 文件损坏：从索引移除并清理
      this.index.delete(key);
      this.totalBytes -= meta.bytes;
      this.safeUnlink(audioPath);
      this.safeUnlink(metaPath);
      return null;
    }
  }

  /** 写入缓存；超限时先淘汰最旧条目。 */
  put(key: string, audio: Buffer, mime: string, sampleRate: number): void {
    if (audio.byteLength > this.maxBytes) return; // 单条超过总预算，不缓存
    this.evictToFit(audio.byteLength);
    const meta: CacheMeta = { mime, lastUsed: Date.now(), bytes: audio.byteLength, sampleRate };
    const tmpAudio = `${this.audioPath(key)}.tmp-${process.pid}`;
    writeFileSync(tmpAudio, audio);
    renameSync(tmpAudio, this.audioPath(key));
    writeFileSync(this.metaPath(key), JSON.stringify(meta), 'utf8');
    const prev = this.index.get(key);
    if (prev) this.totalBytes -= prev.bytes;
    this.index.set(key, meta);
    this.totalBytes += meta.bytes;
  }

  /** 清空缓存（配置变更/角色删除时调用）。 */
  clear(): void {
    for (const key of [...this.index.keys()]) {
      this.remove(key);
    }
  }

  /** 当前占用字节。 */
  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.index.size;
  }

  private remove(key: string): void {
    const meta = this.index.get(key);
    this.index.delete(key);
    if (meta) this.totalBytes -= meta.bytes;
    this.safeUnlink(this.audioPath(key));
    this.safeUnlink(this.metaPath(key));
  }

  /** 淘汰直到可容纳 incoming 字节。 */
  private evictToFit(incoming: number): void {
    if (this.totalBytes + incoming <= this.maxBytes) return;
    const entries = [...this.index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of entries) {
      if (this.totalBytes + incoming <= this.maxBytes) break;
      this.remove(key);
    }
  }

  /** 启动扫描：重建索引，清理孤儿 .json / 损坏条目。 */
  private scan(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      return;
    }
    for (const name of readdirSync(this.dir)) {
      const metaPath = join(this.dir, name);
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      const audioPath = this.audioPath(key);
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CacheMeta;
        const audioStat = statSync(audioPath);
        if (
          typeof meta.mime !== 'string' ||
          typeof meta.bytes !== 'number' ||
          typeof meta.sampleRate !== 'number' ||
          audioStat.size === 0
        ) {
          throw new Error('bad meta');
        }
        meta.bytes = audioStat.size;
        this.index.set(key, meta);
        this.totalBytes += meta.bytes;
      } catch {
        this.safeUnlink(metaPath);
        this.safeUnlink(audioPath);
      }
    }
    // 清理无元数据的孤儿音频
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.wav')) continue;
      const key = name.slice(0, -'.wav'.length);
      if (!this.index.has(key)) this.safeUnlink(join(this.dir, name));
    }
    // 超限时按 LRU 淘汰
    if (this.totalBytes > this.maxBytes) this.evictToFit(0);
  }

  private audioPath(key: string): string {
    return join(this.dir, `${key}.wav`);
  }

  private metaPath(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private safeUnlink(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // 清理失败不致命
    }
  }
}
