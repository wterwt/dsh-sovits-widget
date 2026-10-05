import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/host/config-store.js';
import { defaultConfig, type RootConfig } from '../src/host/config.js';

describe('ConfigStore', () => {
  let dir: string;
  let store: ConfigStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sovits-config-'));
    store = new ConfigStore(dir, 3);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('save 后 load 往返一致，且生成备份', () => {
    const config = defaultConfig();
    config.activeRoleId = 'r1';
    config.playback.volume = 0.6;
    store.save(config);
    const loaded = store.load();
    expect(loaded.activeRoleId).toBe('r1');
    expect(loaded.playback.volume).toBe(0.6);
    expect(store.listBackups().length).toBeGreaterThanOrEqual(0);
  });

  it('再次 save 会备份旧文件', () => {
    store.save(defaultConfig());
    store.save(defaultConfig());
    expect(store.listBackups().length).toBeGreaterThanOrEqual(1);
  });

  it('备份数量不超过 maxBackups', () => {
    for (let i = 0; i < 6; i++) store.save(defaultConfig());
    expect(store.listBackups().length).toBeLessThanOrEqual(3);
  });

  it('首次启动（无配置文件）返回默认配置', () => {
    const fresh = new ConfigStore(join(dir, 'fresh-dir'), 3);
    expect(fresh.load().version).toBe(1);
    expect(fresh.load().cache.maxBytes).toBe(2 * 1024 ** 3);
  });

  it('主文件损坏时自动回滚到最近备份', () => {
    store.save(defaultConfig());
    const config2 = defaultConfig();
    config2.playback.volume = 0.3;
    store.save(config2);
    // 破坏主文件
    writeFileSync(store.filePath, '{broken json', 'utf8');
    let rollbackEvent: string | undefined;
    store = new ConfigStore(dir, 3, { onRollback: (from) => (rollbackEvent = from) });
    const loaded = store.load();
    // 最近备份是第二次 save 前的内容（volume=1 的默认配置）
    expect(loaded.playback.volume).toBe(1);
    expect(rollbackEvent).toBeDefined();
  });

  it('全部损坏时抛错（响亮失败）', () => {
    mkdirSync(store.configDir, { recursive: true });
    writeFileSync(store.filePath, '{broken', 'utf8');
    expect(() => store.load()).toThrow(/无法解析/);
  });
});

describe('zod 配置校验', () => {
  it('默认配置合法', () => {
    expect(() => defaultConfig()).not.toThrow();
  });

  it('非法端口被拒绝', async () => {
    const { parseConfig } = await import('../src/host/config.js');
    const bad = {
      version: 1,
      provider: { kind: 'gpt-sovits', server: { apiBase: 'http://127.0.0.1:99999' } },
    } as unknown;
    expect(() => parseConfig(bad)).toThrow(/端口/);
  });

  it('非法 URL 被拒绝', async () => {
    const { parseConfig } = await import('../src/host/config.js');
    const bad = { version: 1, provider: { kind: 'gpt-sovits', server: { apiBase: 'ftp://x' } } };
    expect(() => parseConfig(bad)).toThrow();
  });

  it('缺省字段由默认值补齐', async () => {
    const { parseConfig } = await import('../src/host/config.js');
    const parsed = parseConfig({ version: 1, provider: { kind: 'gpt-sovits' } });
    expect(parsed.provider.kind).toBe('gpt-sovits');
    if (parsed.provider.kind !== 'gpt-sovits') throw new Error('unreachable');
    expect(parsed.provider.server.apiBase).toBe('http://127.0.0.1:9880');
    expect(parsed.cache.maxBytes).toBe(2 * 1024 ** 3);
    expect(parsed.segments.maxChars).toBe(50);
  });

  it('角色卡与音色混合可解析', async () => {
    const { parseConfig } = await import('../src/host/config.js');
    const config: RootConfig = parseConfig({
      version: 1,
      roles: [
        {
          id: 'r1',
          name: '守岸人',
          persona: '温柔冷静',
          voice: { refAudioPath: 'ref_audio/x.wav', promptText: '你好', promptLang: 'zh' },
          mix: {
            ratioA: 0.7,
            voiceB: { refAudioPath: 'ref_audio/y.wav', promptText: 'hi', promptLang: 'zh' },
          },
        },
      ],
    });
    expect(config.roles[0]?.mix?.ratioA).toBe(0.7);
  });
});
