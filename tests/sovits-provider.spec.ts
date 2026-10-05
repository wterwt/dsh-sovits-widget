import { describe, expect, it } from 'vitest';
import { SovitsProvider, SovitsError, streamMode } from '../src/host/provider/sovits.js';
import { buildWav } from '../src/host/wav.js';
import type { TtsParams } from '../src/host/types.js';

const params: TtsParams = {
  roleId: 'r1',
  textLang: 'auto',
  topK: 15,
  topP: 1,
  temperature: 1,
  speedFactor: 1,
  textSplitMethod: 'cut5',
  refAudioPath: 'ref_audio/a.wav',
  promptText: '你好',
  promptLang: 'zh',
  mediaType: 'wav',
  streamingMode: false,
};

function mockFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return fn as unknown as typeof fetch;
}

/** 固定为 v2 协议，避免探测请求干扰断言。 */
const v2 = { flavor: 'v2' as const };

describe('SovitsProvider', () => {
  it('合成：POST /tts 携带正确参数映射', async () => {
    let captured: RequestInit | undefined;
    const wav = buildWav(new Int16Array([1, 2, 3]), 32000);
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880/',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(async (_url, init) => {
        captured = init;
        return new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      }),
    });
    const result = await provider.synthesize({ text: '你好。', params });
    expect(result.ok).toBe(true);
    expect(result.audio).toBeDefined();
    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body['text']).toBe('你好。');
    expect(body['text_lang']).toBe('auto');
    expect(body['ref_audio_path']).toBe('ref_audio/a.wav');
    expect(body['streaming_mode']).toBe(0);
  });

  it('HTTP 400 返回结构化错误', async () => {
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(
        async () => new Response(JSON.stringify({ message: 'ref_audio_path is required' }), { status: 400 }),
      ),
    });
    const result = await provider.synthesize({ text: '你好。', params });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ref_audio_path is required');
  });

  it('网络失败返回可重试错误', async () => {
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const result = await provider.synthesize({ text: '你好。', params });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('无法连接');
  });

  it('健康检查：HTTP 响应即视为存活', async () => {
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(async () => new Response(null, { status: 200 })),
    });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
  });

  it('健康检查：网络失败累计连续失败', async () => {
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(async () => {
        throw new Error('down');
      }),
    });
    await provider.healthCheck();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.consecutiveFailures).toBe(2);
  });

  it('流式 wav：拆出头部与 PCM 块', async () => {
    const header = buildWav(new Int16Array(0), 32000).subarray(0, 44);
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const chunks = [header, pcm.subarray(0, 2), pcm.subarray(2)];
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }),
    });
    const collected: Uint8Array[] = [];
    for await (const block of provider.synthesizeStream!({
      text: '你好。',
      params: { ...params, streamingMode: 2 },
    })) {
      expect(block.sampleRate).toBe(32000);
      collected.push(block.pcm16);
    }
    const total = collected.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(pcm.byteLength);
  });

  it('streamMode 规范化', () => {
    expect(streamMode({ streamingMode: true })).toBe(1);
    expect(streamMode({ streamingMode: false })).toBe(0);
    expect(streamMode({ streamingMode: 3 })).toBe(3);
    expect(streamMode({ streamingMode: 99 as never })).toBe(0);
  });

  it('SovitsError 携带状态码', () => {
    const err = new SovitsError('x', 500, true);
    expect(err.retryable).toBe(true);
  });

  it('切换权重端点（新版协议）', async () => {
    const calls: string[] = [];
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      ...v2,
      fetchImpl: mockFetch(async (url) => {
        calls.push(url);
        return new Response('success', { status: 200 });
      }),
    });
    await provider.setGptWeights('GPT_weights/x.ckpt');
    await provider.setSovitsWeights('SoVITS_weights/x.pth');
    await provider.setReferAudio('ref_audio/a.wav');
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain('/set_gpt_weights?weights_path=GPT_weights%2Fx.ckpt');
    expect(calls[1]).toContain('/set_sovits_weights');
    expect(calls[2]).toContain('/set_refer_audio');
  });
});
