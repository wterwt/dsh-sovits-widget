/**
 * TTSProvider 抽象：插件支持任意合成后端（本地 Python / 远程 HTTP），
 * 默认实现为 GPT-SoVITS api_v2；降级实现为 Web Speech（客户端执行，
 * 宿主侧仅返回标记）。
 */

import type { HealthStatus, SynthesizeResult, TtsParams } from '../types.js';

/** 流式合成输出块（PCM16 原始采样）。 */
export interface AudioChunk {
  /** PCM16 单声道。 */
  pcm16: Uint8Array;
  /** 采样率。 */
  sampleRate: number;
}

export interface SynthesizeRequest {
  text: string;
  params: TtsParams;
  signal?: AbortSignal;
}

export interface TTSProvider {
  readonly kind: 'gpt-sovits' | 'webspeech';

  /** 健康检查（Ping）。 */
  healthCheck(signal?: AbortSignal): Promise<HealthStatus>;

  /** 合成为完整 WAV（内部可走流式接口后重组）。 */
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;

  /** 流式合成（若后端支持；不支持时直接抛 NotSupported 错误）。 */
  synthesizeStream?(req: SynthesizeRequest): AsyncIterable<AudioChunk>;

  /** 释放资源（关闭子进程等）。 */
  dispose(): Promise<void>;
}
