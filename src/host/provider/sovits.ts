/**
 * GPT-SoVITS Provider，同时支持两代 HTTP 接口。
 *
 * 新版 api_v2（默认）：
 * - POST /tts              合成（wav/raw/ogg/aac；streaming_mode 0-3）
 * - GET  /control?command=ping|restart|exit
 * - GET  /set_refer_audio?refer_audio_path=
 * - GET  /set_gpt_weights?weights_path= / set_sovits_weights
 *
 * 旧版 api.py（flavor='legacy'，见 protocol.ts）：
 * - POST /                 合成（refer_wav_path / text_language / speed / cut_punc / inp_refs）
 * - GET  /control?command=ping|restart|exit
 * - GET  /change_refer?refer_wav_path=&prompt_text=&prompt_language=
 * - GET  /set_model?gpt_model_path=&sovits_model_path=
 *
 * 协议由 probeFlavor() 自动探测；探测失败时按新版处理。
 * 流式 wav 响应：首块为 44 字节 WAV 头 + 空数据，随后为裸 PCM16 块；
 * 本 Provider 将其重组为完整 WAV，供缓存与客户端播放。
 */

import type { HealthStatus, SynthesizeResult, TtsParams } from '../types.js';
import { buildWav, mixPcm16, parseWav } from '../wav.js';
import { cleanText } from '../text-cleaner.js';
import type { SynthParams, VoiceParams } from '../config.js';
import { TTSProvider, AudioChunk, SynthesizeRequest } from './types.js';
import { probeFlavor, type SovitsFlavor } from './protocol.js';

export interface SovitsProviderOptions {
  /** API 基址，例如 http://127.0.0.1:9880。 */
  apiBase: string;
  /** 请求超时（毫秒）。 */
  timeoutMs: number;
  /**
   * 接口代际：'auto' 自动探测（默认），或强制 'v2' / 'legacy'。
   */
  flavor?: SovitsFlavor | 'auto';
  /** fetch 实现（测试注入）。 */
  fetchImpl?: typeof fetch;
}

export class SovitsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SovitsError';
  }
}

/** 流式模式 2/3 的 WAV 头长度。 */
const WAV_HEADER_BYTES = 44;

export class SovitsProvider implements TTSProvider {
  readonly kind = 'gpt-sovits' as const;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly configuredFlavor: SovitsFlavor | 'auto';
  private failures = 0;
  /** 已探测/配置生效的协议代际。 */
  private flavor: SovitsFlavor = 'v2';
  /** 探测依据（诊断用）。 */
  private flavorReason = '尚未探测';
  private probed = false;
  /** 旧版协议：暂存待与 SoVITS 权重一起提交的 GPT 权重路径。 */
  private pendingGptPath: string | undefined;

  constructor(options: SovitsProviderOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.configuredFlavor = options.flavor ?? 'auto';
    if (this.configuredFlavor !== 'auto') {
      this.flavor = this.configuredFlavor;
      this.flavorReason = `配置强制为 ${this.configuredFlavor}`;
      this.probed = true;
    }
  }

  /** 当前生效的协议代际。 */
  get protocolFlavor(): SovitsFlavor {
    return this.flavor;
  }

  /** 探测依据（写入诊断日志）。 */
  get protocolReason(): string {
    return this.flavorReason;
  }

  /**
   * 确保协议已探测（幂等）。首次调用会请求服务端特征端点。
   */
  async ensureFlavor(signal?: AbortSignal): Promise<SovitsFlavor> {
    if (this.probed) return this.flavor;
    const result = await probeFlavor(this.apiBase, this.fetchImpl, signal);
    this.flavor = result.flavor;
    this.flavorReason = result.reason;
    this.probed = true;
    return this.flavor;
  }

  async healthCheck(signal?: AbortSignal): Promise<HealthStatus> {
    try {
      // 两代 api 都实现了 /control（command 未知时旧版返回 200、新版 200），
      // 因此任何非 5xx 响应都说明服务进程活着。
      const res = await this.fetchImpl(`${this.apiBase}/control?command=ping`, {
        method: 'GET',
        signal: this.withTimeout(signal, 5000),
      });
      const ok = res.status < 500;
      if (ok) {
        this.failures = 0;
        // 服务可用时顺便完成协议探测（失败不影响健康判定）
        if (!this.probed) {
          try {
            await this.ensureFlavor(signal);
          } catch {
            // 探测异常不影响健康检查结果
          }
        }
      }
      return {
        ok,
        consecutiveFailures: this.failures,
        degraded: false,
        lastError: ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (err) {
      this.failures += 1;
      return {
        ok: false,
        consecutiveFailures: this.failures,
        degraded: false,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 合成一段文本为完整 WAV。 */
  async synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
    const started = Date.now();
    const { text, params, signal } = req;
    const voice = voiceFromParams(params);
    try {
      const audio = await this.synthesizeWav(text, params, signal);
      this.failures = 0;
      return {
        ok: true,
        audio,
        mime: 'audio/wav',
        sampleRate: SOVITS_SAMPLE_RATE,
        elapsedMs: Date.now() - started,
        voice: { refAudioPath: voice.refAudioPath, promptText: voice.promptText, promptLang: voice.promptLang },
      };
    } catch (err) {
      this.failures += 1;
      const sovits = err instanceof SovitsError ? err : undefined;
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - started,
        voice: { refAudioPath: voice.refAudioPath, promptText: voice.promptText, promptLang: voice.promptLang },
        ...(sovits ? { status: sovits.status } : {}),
      };
    }
  }

  /** 流式合成：逐块产出 PCM16。 */
  async *synthesizeStream(req: SynthesizeRequest): AsyncIterable<AudioChunk> {
    const { text, params, signal } = req;
    await this.ensureFlavor(signal);
    // 旧版 api.py 不支持按请求流式（其流式由启动参数 -sm 控制且格式不同），
    // 统一退化为整段合成后一次性产出，保证行为一致。
    const streaming = this.flavor === 'legacy' ? 0 : streamMode(params);
    if (streaming === 0) {
      const wav = await this.synthesizeWav(text, params, signal);
      const { sampleRate, pcm16 } = parseWav(wav);
      yield { pcm16: new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), sampleRate };
      return;
    }
    const res = await this.requestTts(text, params, signal);
    if (!res.body) throw new SovitsError('流式响应缺少 body', res.status, true);
    const reader = res.body.getReader();
    const headerChunks: Uint8Array[] = [];
    let header: Uint8Array | null = null;
    let sampleRate = SOVITS_SAMPLE_RATE;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (header === null) {
        headerChunks.push(value);
        const total = headerChunks.reduce((n, c) => n + c.byteLength, 0);
        if (total < WAV_HEADER_BYTES) continue;
        // 拼接出头部解析采样率（fmt 块内），剩余为 PCM
        const merged = concatChunks(headerChunks);
        header = merged.subarray(0, WAV_HEADER_BYTES);
        sampleRate = headerSampleRate(header);
        const rest = merged.subarray(WAV_HEADER_BYTES);
        if (rest.byteLength > 0) yield { pcm16: rest, sampleRate };
        continue;
      }
      if (value.byteLength > 0) yield { pcm16: value, sampleRate };
    }
    // 头部未完整收到的流直接丢弃（不产出半截音频）
  }

  /** 切换 GPT 权重。 */
  async setGptWeights(weightsPath: string, signal?: AbortSignal): Promise<void> {
    await this.ensureFlavor(signal);
    if (this.flavor === 'legacy') {
      // 旧版无独立 GPT 权重端点，记下待与 SoVITS 一起通过 /set_model 切换
      this.pendingGptPath = weightsPath;
      return;
    }
    await this.simpleGet(`/set_gpt_weights?weights_path=${encodeURIComponent(weightsPath)}`, signal);
  }

  /** 切换 SoVITS 权重。 */
  async setSovitsWeights(weightsPath: string, signal?: AbortSignal): Promise<void> {
    await this.ensureFlavor(signal);
    if (this.flavor === 'legacy') {
      // 旧版一次性切换两个权重
      const gpt = this.pendingGptPath ?? weightsPath;
      this.pendingGptPath = undefined;
      await this.simpleGet(
        `/set_model?gpt_model_path=${encodeURIComponent(gpt)}&sovits_model_path=${encodeURIComponent(weightsPath)}`,
        signal,
      );
      return;
    }
    await this.simpleGet(`/set_sovits_weights?weights_path=${encodeURIComponent(weightsPath)}`, signal);
  }

  /** 预热参考音频。 */
  async setReferAudio(refAudioPath: string, signal?: AbortSignal): Promise<void> {
    await this.ensureFlavor(signal);
    if (this.flavor === 'legacy') {
      await this.simpleGet(`/change_refer?refer_wav_path=${encodeURIComponent(refAudioPath)}`, signal);
      return;
    }
    await this.simpleGet(`/set_refer_audio?refer_audio_path=${encodeURIComponent(refAudioPath)}`, signal);
  }

  /** 重启服务端。 */
  async restartServer(signal?: AbortSignal): Promise<void> {
    await this.simpleGet('/control?command=restart', signal);
  }

  async dispose(): Promise<void> {
    // HTTP Provider 无本地资源
  }

  /** 非流式：请求 /tts 并解析为完整 WAV。 */
  private async synthesizeWav(text: string, params: TtsParams, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.requestTts(text, params, signal);
    const buffer = new Uint8Array(await res.arrayBuffer());
    // 兜底：部分部署直接返回 PCM（raw）；此处按 WAV 校验，失败视为 raw PCM
    if (isWav(buffer)) return buffer;
    return buildWav(buffer, SOVITS_SAMPLE_RATE);
  }

  private async requestTts(text: string, params: TtsParams, signal?: AbortSignal): Promise<Response> {
    const cleaned = cleanText(text);
    await this.ensureFlavor(signal);
    const legacy = this.flavor === 'legacy';
    const body: Record<string, unknown> = legacy
      ? {
          // 旧版 api.py 字段
          text: cleaned,
          text_language: params.textLang,
          refer_wav_path: params.refAudioPath,
          prompt_text: params.promptText,
          prompt_language: params.promptLang,
          inp_refs: params.auxRefAudioPaths ?? [],
          top_k: params.topK,
          top_p: params.topP,
          temperature: params.temperature,
          speed: params.speedFactor,
          cut_punc: params.textSplitMethod,
        }
      : {
          // 新版 api_v2 字段
          text: cleaned,
          text_lang: params.textLang,
          ref_audio_path: params.refAudioPath,
          prompt_text: params.promptText,
          prompt_lang: params.promptLang,
          aux_ref_audio_paths: params.auxRefAudioPaths ?? [],
          top_k: params.topK,
          top_p: params.topP,
          temperature: params.temperature,
          text_split_method: params.textSplitMethod,
          batch_size: 1,
          speed_factor: params.speedFactor,
          media_type: params.mediaType,
          streaming_mode: streamMode(params),
        };
    const endpoint = legacy ? `${this.apiBase}/` : `${this.apiBase}/tts`;
    const timeoutSignal = this.withTimeout(signal, this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new SovitsError(
        aborted ? '合成请求被取消或超时' : `无法连接 GPT-SoVITS 服务: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        true,
      );
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { message?: string };
        if (json.message) message = json.message;
      } catch {
        // 响应体不是 JSON
      }
      throw new SovitsError(`GPT-SoVITS 合成失败: ${message}`, res.status, res.status >= 500);
    }
    return res;
  }

  private async simpleGet(path: string, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'GET',
      signal: this.withTimeout(signal, this.timeoutMs),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { message?: string };
        if (json.message) message = json.message;
      } catch {
        // 非 JSON 响应体
      }
      throw new SovitsError(message, res.status, res.status >= 500);
    }
  }

  private withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    return signal ?? AbortSignal.timeout(ms);
  }
}

/** GPT-SoVITS 输出采样率（v2+ 固定 32000；若流式头解析出其他值以头为准）。 */
export const SOVITS_SAMPLE_RATE = 32000;

/** 解析流式模式：true->1，false/0->0，1/2/3 原样。 */
export function streamMode(params: Pick<TtsParams, 'streamingMode'>): 0 | 1 | 2 | 3 {
  const v = params.streamingMode;
  if (v === true) return 1;
  if (v === false || v === 0 || v === undefined) return 0;
  if (v === 1 || v === 2 || v === 3) return v;
  return 0;
}

/** 从 TtsParams 提取音色信息。 */
export function voiceFromParams(params: TtsParams): VoiceParams {
  return {
    refAudioPath: params.refAudioPath,
    promptText: params.promptText,
    promptLang: params.promptLang as VoiceParams['promptLang'],
    ...(params.gptWeightsPath ? { gptWeightsPath: params.gptWeightsPath } : {}),
    ...(params.sovitsWeightsPath ? { sovitsWeightsPath: params.sovitsWeightsPath } : {}),
  };
}

function isWav(buffer: Uint8Array): boolean {
  return (
    buffer.byteLength >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  );
}

function headerSampleRate(header: Uint8Array): number {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return view.getUint32(24, true);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** 音色混合（70% A + 30% B 等）：并行合成两路并加权混合。 */
export async function synthesizeVoiceMix(
  provider: SovitsProvider,
  base: SynthesizeRequest,
  voiceB: VoiceParams,
  synthB: Partial<SynthParams>,
  ratioA: number,
  signal?: AbortSignal,
): Promise<SynthesizeResult> {
  const paramsB: TtsParams = {
    ...base.params,
    refAudioPath: voiceB.refAudioPath,
    promptText: voiceB.promptText,
    promptLang: voiceB.promptLang,
    ...(voiceB.gptWeightsPath ? { gptWeightsPath: voiceB.gptWeightsPath } : {}),
    ...(voiceB.sovitsWeightsPath ? { sovitsWeightsPath: voiceB.sovitsWeightsPath } : {}),
    ...synthB,
    mixRatioA: ratioA,
    auxRefAudioPaths: undefined,
  };
  const [a, b] = await Promise.all([
    provider.synthesize({ ...base, signal }),
    provider.synthesize({ text: base.text, params: paramsB, signal }),
  ]);
  if (!a.ok || !a.audio) return a;
  if (!b.ok || !b.audio) return a; // B 失败时退化为 A 独播
  const wa = parseWav(a.audio);
  const wb = parseWav(b.audio);
  const rate = Math.max(wa.sampleRate, wb.sampleRate);
  const mixed = mixPcm16(wa.pcm16, wb.pcm16, ratioA);
  return {
    ok: true,
    audio: buildWav(new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength), rate),
    mime: 'audio/wav',
    sampleRate: rate,
    elapsedMs: (a.elapsedMs ?? 0) + (b.elapsedMs ?? 0),
    voice: a.voice,
  };
}
