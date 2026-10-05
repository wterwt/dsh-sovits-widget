import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LruAudioCache, cacheKey } from '../src/host/lru-cache.js';
import { buildWav } from '../src/host/wav.js';
import type { TtsParams } from '../src/host/types.js';

const params: TtsParams = {
  roleId: 'r1',
  textLang: 'zh',
  topK: 15,
  topP: 1,
  temperature: 1,
  speedFactor: 1,
  textSplitMethod: 'cut5',
  refAudioPath: 'a.wav',
  promptText: '',
  promptLang: 'zh',
  mediaType: 'wav',
  streamingMode: false,
};

describe('LruAudioCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sovits-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('put/get 命中并返回采样率', () => {
    const cache = new LruAudioCache(dir, 1024 * 1024);
    const key = cacheKey('r1', '你好', params);
    const wav = buildWav(new Int16Array([1, 2, 3]), 32000);
    cache.put(key, Buffer.from(wav), 'audio/wav', 32000);
    const hit = cache.get(key);
    expect(hit).not.toBeNull();
    expect(hit?.mime).toBe('audio/wav');
    expect(hit?.sampleRate).toBe(32000);
    expect(Array.from(hit?.audio ?? [])).toEqual(Array.from(wav));
  });

  it('不同文本/音色参数产生不同键', () => {
    const k1 = cacheKey('r1', '你好', params);
    const k2 = cacheKey('r1', '你好', { ...params, topK: 20 });
    const k3 = cacheKey('r1', '再见', params);
    const k4 = cacheKey('r2', '你好', params);
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
  });

  it('超过预算时按 LRU 淘汰最旧条目', () => {
    const cache = new LruAudioCache(dir, 2000);
    const audio = Buffer.alloc(1000, 1);
    const keys = ['a', 'b', 'c'].map((t) => cacheKey('r1', t, params));
    for (const key of keys) cache.put(key, audio, 'audio/wav', 32000);
    // 3×1000 字节数据 + 元数据，仅能容纳约 2 条
    expect(cache.size).toBeLessThanOrEqual(2);
    // 最旧的 a 应被淘汰，最新的 c 应命中
    expect(cache.get(keys[0] ?? '')).toBeNull();
    expect(cache.get(keys[2] ?? '')).not.toBeNull();
  });

  it('重启扫描后索引可恢复', () => {
    const cache = new LruAudioCache(dir, 1024 * 1024);
    const key = cacheKey('r1', '你好', params);
    cache.put(key, Buffer.from(buildWav(new Int16Array([5]), 32000)), 'audio/wav', 32000);
    const revived = new LruAudioCache(dir, 1024 * 1024);
    expect(revived.get(key)).not.toBeNull();
  });

  it('clear 清空全部', () => {
    const cache = new LruAudioCache(dir, 1024 * 1024);
    const key = cacheKey('r1', '你好', params);
    cache.put(key, Buffer.from(buildWav(new Int16Array([5]), 32000)), 'audio/wav', 32000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(key)).toBeNull();
  });
});
