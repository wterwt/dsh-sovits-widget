import { describe, expect, it } from 'vitest';
import { SovitsProvider } from '../src/host/provider/sovits.js';
import { probeFlavor } from '../src/host/provider/protocol.js';
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

/** 模拟旧版 api.py：/tts 返回 404，根路径可用。 */
function legacyFetch(audio: Uint8Array, onTts?: (body: Record<string, unknown>, url: string) => void) {
  return mockFetch(async (url, init) => {
    const target = String(url);
    if (target.includes('/tts')) return new Response('Not Found', { status: 404 });
    if (target.includes('/control')) return new Response('OK', { status: 200 });
    if (target.includes('/set_model') || target.includes('/change_refer')) {
      return new Response(JSON.stringify({ code: 0, message: 'Success' }), { status: 200 });
    }
    if (target.includes('/set_gpt_weights')) return new Response('Not Found', { status: 404 });
    // 根路径 GET（探测）与 POST（合成）都可达；探测请求没有 body
    if (init?.body) {
      onTts?.(JSON.parse(String(init.body)) as Record<string, unknown>, target);
      return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }
    // 探测：缺少参考音频时旧版返回 400
    return new Response(JSON.stringify({ message: 'ref_wav_path is required' }), { status: 400 });
  });
}

/** 模拟新版 api_v2：/tts 可用，根路径 404。 */
function v2Fetch(audio: Uint8Array, onTts?: (body: Record<string, unknown>, url: string) => void) {
  return mockFetch(async (url, init) => {
    const target = String(url);
    if (target.includes('/control')) return new Response('OK', { status: 200 });
    if (target.includes('/tts')) {
      if (init?.body) {
        onTts?.(JSON.parse(String(init.body)) as Record<string, unknown>, target);
        return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      }
      // 探测：缺参数时新版返回 500
      return new Response('Internal Server Error', { status: 500 });
    }
    // 根路径在新版不存在
    return new Response('Not Found', { status: 404 });
  });
}

describe('协议探测 probeFlavor', () => {
  it('根路径可达（非 404）时判为 legacy', async () => {
    const result = await probeFlavor(
      'http://127.0.0.1:9880',
      mockFetch(async (url) => {
        // 旧版：根路径存在，/tts 不存在
        if (String(url).includes('/tts')) return new Response('Not Found', { status: 404 });
        return new Response(JSON.stringify({ message: 'ref_wav_path is required' }), { status: 400 });
      }),
    );
    expect(result.flavor).toBe('legacy');
    expect(result.reason).toContain('根路径');
  });

  it('根路径 404 而 /tts 存在时判为 v2', async () => {
    const result = await probeFlavor(
      'http://127.0.0.1:9880',
      mockFetch(async (url) => {
        // 新版：根路径 404，/tts 存在（缺参数返回 500）
        if (String(url).includes('/tts')) return new Response('Internal Error', { status: 500 });
        return new Response('Not Found', { status: 404 });
      }),
    );
    expect(result.flavor).toBe('v2');
    expect(result.reason).toContain('/tts');
  });

  it('全部 404 时回退到 v2', async () => {
    const result = await probeFlavor(
      'http://127.0.0.1:9880',
      mockFetch(async () => new Response('Not Found', { status: 404 })),
    );
    expect(result.flavor).toBe('v2');
  });

  it('网络异常时回退到 v2', async () => {
    const result = await probeFlavor(
      'http://127.0.0.1:9880',
      mockFetch(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(result.flavor).toBe('v2');
  });
});

describe('旧版 api.py 兼容', () => {
  it('force legacy 时向根路径发送旧版字段', async () => {
    let captured: { body: Record<string, unknown>; url: string } | null = null;
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      flavor: 'legacy',
      fetchImpl: legacyFetch(buildWav(new Int16Array([1, 2, 3]), 32000), (body, url) => {
        captured = { body, url };
      }),
    });
    const result = await provider.synthesize({ text: '你好。', params });
    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    const body = (captured as unknown as { body: Record<string, unknown> }).body;
    const url = (captured as unknown as { url: string }).url;
    // 旧版字段名
    expect(body['refer_wav_path']).toBe('ref_audio/a.wav');
    expect(body['text_language']).toBe('auto');
    expect(body['prompt_language']).toBe('zh');
    expect(body['speed']).toBe(1);
    expect(body['cut_punc']).toBe('cut5');
    expect(body['inp_refs']).toEqual([]);
    // 不应出现新版字段
    expect(body['ref_audio_path']).toBeUndefined();
    expect(body['text_lang']).toBeUndefined();
    expect(body['speed_factor']).toBeUndefined();
    // 端点是根路径
    expect(url.endsWith('/')).toBe(true);
    expect(url).not.toContain('/tts');
  });

  it('auto 探测到旧版后自动使用旧版字段', async () => {
    const audio = buildWav(new Int16Array([4, 5, 6]), 32000);
    let captured: Record<string, unknown> | null = null;
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      flavor: 'auto',
      fetchImpl: legacyFetch(audio, (body) => {
        if (body['text']) captured = body;
      }),
    });
    const result = await provider.synthesize({ text: '测试。', params });
    expect(result.ok).toBe(true);
    expect(provider.protocolFlavor).toBe('legacy');
    expect((captured as unknown as Record<string, unknown>)['refer_wav_path']).toBe('ref_audio/a.wav');
  });

  it('auto 探测到新版后使用新版字段', async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      flavor: 'auto',
      fetchImpl: v2Fetch(buildWav(new Int16Array([7]), 32000), (body, url) => {
        if (url.includes('/tts')) captured = body;
      }),
    });
    await provider.synthesize({ text: '测试。', params });
    expect(provider.protocolFlavor).toBe('v2');
    expect((captured as unknown as Record<string, unknown>)['ref_audio_path']).toBe('ref_audio/a.wav');
    expect((captured as unknown as Record<string, unknown>)['speed_factor']).toBe(1);
  });

  it('旧版权重切换走 /set_model（GPT 与 SoVITS 合并提交）', async () => {
    const calls: string[] = [];
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      flavor: 'legacy',
      fetchImpl: mockFetch(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ code: 0, message: 'Success' }), { status: 200 });
      }),
    });
    await provider.setGptWeights('GPT_weights/x.ckpt');
    // 旧版不立即请求，等 SoVITS 一起提交
    expect(calls.length).toBe(0);
    await provider.setSovitsWeights('SoVITS_weights/x.pth');
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('/set_model');
    expect(calls[0]).toContain('gpt_model_path=GPT_weights%2Fx.ckpt');
    expect(calls[0]).toContain('sovits_model_path=SoVITS_weights%2Fx.pth');
  });

  it('旧版换参考音频走 /change_refer', async () => {
    const calls: string[] = [];
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      flavor: 'legacy',
      fetchImpl: mockFetch(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }),
    });
    await provider.setReferAudio('ref_audio/a.wav');
    expect(calls[0]).toContain('/change_refer');
    expect(calls[0]).toContain('refer_wav_path=ref_audio%2Fa.wav');
  });

  it('旧版流式请求退化为整段返回', async () => {
    const audio = buildWav(new Int16Array([1, 2, 3, 4]), 32000);
    const provider = new SovitsProvider({
      apiBase: 'http://127.0.0.1:9880',
      timeoutMs: 5000,
      flavor: 'legacy',
      fetchImpl: legacyFetch(audio),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream!({
      text: '测试。',
      params: { ...params, streamingMode: 2 },
    })) {
      chunks.push(chunk.pcm16);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(8); // 4 个 int16
  });
});
