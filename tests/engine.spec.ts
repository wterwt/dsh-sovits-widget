import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/host/config.js';
import { Diagnostics } from '../src/host/diagnostics.js';
import { TtsEngine } from '../src/host/engine.js';
import { buildWav } from '../src/host/wav.js';

function makeEngine(options?: {
  failing?: boolean;
  dir?: string;
  fetchImpl?: typeof fetch;
  retryCount?: number;
  retryDelayMs?: number;
}) {
  const dir = options?.dir ?? mkdtempSync(join(tmpdir(), 'sovits-engine-'));
  const config = defaultConfig();
  const baseParams = config.provider.kind === 'gpt-sovits' ? config.provider.params : null;
  if (!baseParams) throw new Error('默认 provider 必须是 gpt-sovits');
  config.provider = {
    kind: 'gpt-sovits',
    server: {
      apiBase: 'http://127.0.0.1:9880',
      autoStart: false,
      pythonExecutable: 'python',
      apiScript: '',
      cwd: '',
      extraArgs: [],
      concurrency: 1,
      timeoutMs: 5000,
      healthCheckIntervalMs: 60000,
      flavor: 'auto',
    },
    params: baseParams,
  };
  config.cache = { enabled: true, maxBytes: 64 * 1024 * 1024, dir: join(dir, 'cache') };
  config.fallback.maxConsecutiveFailures = 3;
  config.fallback.retryCount = options?.retryCount ?? 0; // 测试默认不重试（保持旧语义）
  config.fallback.retryDelayMs = options?.retryDelayMs ?? 10;
  config.roles = [
    {
      id: 'r1',
      name: '守岸人',
      persona: '温柔冷静的向导',
      voice: { refAudioPath: 'ref_audio/a.wav', promptText: '你好', promptLang: 'zh' },
    },
  ];
  config.activeRoleId = 'r1';

  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const wav = buildWav(new Int16Array([1000, -1000, 2000, -2000]), 32000);
  const defaultFetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (options?.failing) throw new Error('ECONNREFUSED');
    if (target.includes('/control')) return new Response(null, { status: 200 });
    if (target.includes('/set_')) return new Response('success', { status: 200 });
    // 新版 api_v2 无根路由：探测根路径时返回 404，避免被误判为旧版
    if (/^https?:\/\/[^/]+\/(\?|$)/.test(target)) return new Response('Not Found', { status: 404 });
    return new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  }) as typeof fetch;
  const fetchImpl = (options?.fetchImpl ?? defaultFetch) as typeof fetch;

  const engine = new TtsEngine({
    dataDir: dir,
    diagnostics: new Diagnostics(100),
    initialConfig: config,
    fetchImpl,
  });
  return { engine, config, calls, dir, wav };
}

describe('TtsEngine', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sovits-engine-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('清洗→分段→合成→发布完整链路', async () => {
    const { engine, calls } = makeEngine({ dir });
    engine.speakMessage('m1', '你好！```js\ncode\n``` 今天天气不错。');
    const status = await vi.waitFor(
      async () => {
        const s = engine.getStatus('m1');
        expect(s?.done).toBe(true);
        return s!;
      },
      { timeout: 5000 },
    );
    expect(status.total).toBeGreaterThanOrEqual(2);
    expect(status.ready.every((r) => r.kind === 'audio')).toBe(true);
    expect(calls.some((c) => c.url.includes('/tts'))).toBe(true);
    // 代码块被替换，合成文本不含代码
    const ttsBodies = calls.filter((c) => c.url.includes('/tts')).map((c) => c.body);
    const joined = ttsBodies.map((b) => String(b?.['text'])).join('');
    expect(joined).toContain('省略代码');
    expect(joined).not.toContain('code');
    // 音频可取
    const first = status.ready[0];
    expect(first?.token).toBeTruthy();
    expect(engine.getAudio(first!.token)).not.toBeNull();
  });

  it('无角色时整条降级为 Web Speech 文本段', () => {
    const { engine, config } = makeEngine({ dir });
    config.activeRoleId = '';
    engine.applyConfig(config);
    engine.speakMessage('m2', '你好世界。');
    const status = engine.getStatus('m2');
    expect(status?.done).toBe(true);
    expect(status?.ready[0]?.kind).toBe('webspeech');
    expect(status?.ready[0]?.text).toBe('你好世界。');
  });

  it('连续失败 3 次后新段降级为 Web Speech', async () => {
    const { engine } = makeEngine({ dir, failing: true });
    engine.speakMessage('m3', '第一句！第二句！第三句！第四句！');
    const status = await vi.waitFor(
      async () => {
        const s = engine.getStatus('m3');
        expect(s?.done).toBe(true);
        return s!;
      },
      { timeout: 5000 },
    );
    expect(status.total).toBe(4);
    // 前 2 段失败（错误段）；第 3 段触发降级后改为 Web Speech；第 4 段同样
    expect(status.ready.slice(0, 2).every((r) => r.error !== undefined)).toBe(true);
    expect(status.ready[2]?.kind).toBe('webspeech');
    expect(status.ready[3]?.kind).toBe('webspeech');
    expect(engine.healthStatus.degraded).toBe(true);
  });

  it('barge-in：stopAll 后消息立即 done 且标记已停止', () => {
    const { engine } = makeEngine({ dir });
    engine.speakMessage('m4', '第一句。第二句。');
    engine.stopAll();
    const status = engine.getStatus('m4');
    expect(status?.done).toBe(true);
    expect(status?.error).toBe('已停止');
  });

  it('音色混合：并行合成两路并加权混合', async () => {
    const { engine, config, calls } = makeEngine({ dir });
    config.roles[0]!.mix = {
      ratioA: 0.7,
      voiceB: { refAudioPath: 'ref_audio/b.wav', promptText: 'hi', promptLang: 'zh' },
    };
    engine.applyConfig(config);
    engine.speakMessage('m5', '你好。');
    const status = await vi.waitFor(
      async () => {
        const s = engine.getStatus('m5');
        expect(s?.done).toBe(true);
        return s!;
      },
      { timeout: 5000 },
    );
    expect(status.ready[0]?.kind).toBe('audio');
    // 只统计真正的合成请求（带 body 的 POST /tts），排除协议探测请求
    const ttsCalls = calls.filter((c) => c.url.includes('/tts') && c.body !== undefined);
    expect(ttsCalls.length).toBe(2);
    const refs = ttsCalls.map((c) => String(c.body?.['ref_audio_path']));
    expect(refs).toContain('ref_audio/a.wav');
    expect(refs).toContain('ref_audio/b.wav');
  });

  it('情感映射：开心消息切换参考音频', async () => {
    const { engine, config, calls } = makeEngine({ dir });
    config.roles[0]!.emotions = {
      happy: { voice: { refAudioPath: 'ref_audio/happy.wav', promptText: '开心', promptLang: 'zh' } },
    };
    engine.applyConfig(config);
    engine.speakMessage('m6', '哈哈，太棒了！');
    const status = await vi.waitFor(
      async () => {
        const s = engine.getStatus('m6');
        expect(s?.done).toBe(true);
        return s!;
      },
      { timeout: 5000 },
    );
    expect(status.ready[0]?.emotion).toBe('happy');
    const ttsCalls = calls.filter((c) => c.url.includes('/tts'));
    expect(ttsCalls.map((c) => String(c.body?.['ref_audio_path']))).toContain('ref_audio/happy.wav');
  });

  it('连接级失败自动重试：两次失败后第三次成功', async () => {
    const wav = buildWav(new Int16Array([1, 2, 3]), 32000);
    let ttsCalls = 0;
    const flakyFetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/tts')) {
        if (init?.body === undefined) return new Response('Internal Server Error', { status: 500 }); // 探测
        ttsCalls += 1;
        if (ttsCalls <= 2) throw new Error('ECONNREFUSED');
      }
      if (/^https?:\/\/[^/]+\/(\?|$)/.test(target)) return new Response('Not Found', { status: 404 });
      return new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }) as typeof fetch;
    const { engine } = makeEngine({ dir, fetchImpl: flakyFetch, retryCount: 2, retryDelayMs: 10 });
    engine.speakMessage('m7', '你好。');
    const status = await vi.waitFor(
      async () => {
        const s = engine.getStatus('m7');
        expect(s?.done).toBe(true);
        return s!;
      },
      { timeout: 5000 },
    );
    expect(ttsCalls).toBe(3); // 首次 + 2 次重试
    expect(status.ready[0]?.kind).toBe('audio');
    expect(engine.healthStatus.degraded).toBe(false);
  });
});
