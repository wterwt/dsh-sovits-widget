/**
 * 参考音频处理（AudioTool）：上传的参考音频经 ffmpeg
 * 「降噪 + 掐头去静音 + 截取 3-10 秒最佳片段」，输出 44.1kHz 单声道 PCM16 WAV。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Diagnostics } from './diagnostics.js';

export interface ProcessAudioResult {
  ok: boolean;
  /** 输出文件绝对路径。 */
  path?: string;
  /** 输出时长（毫秒）。 */
  durationMs?: number;
  error?: string;
}

export interface AudioToolOptions {
  /** 输出目录。 */
  outputDir: string;
  /** 显式 ffmpeg 路径（空=自动探测）。 */
  ffmpegPath: string;
  /** 探测候选（部署相关路径，如 GPT-SoVITS 自带 runtime）。 */
  extraCandidates: string[];
  /** 截取上限（秒），默认 10。 */
  maxSeconds: number;
  /** 最少可用时长（秒），默认 3。 */
  minSeconds: number;
  diagnostics: Diagnostics;
}

export function resolveFfmpeg(explicit: string, extraCandidates: string[]): string | null {
  const candidates = [
    explicit,
    process.env.FFMPEG_PATH ?? '',
    ...extraCandidates,
    'ffmpeg',
    'ffmpeg.exe',
  ].filter((c) => c.length > 0);
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\') || candidate.endsWith('.exe')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    // PATH 命令：用 spawnSync 探测
    const probe = spawnSync(candidate, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    if (probe.error === undefined) return candidate;
  }
  return null;
}

/** 处理音频并写入输出目录，返回最终路径。 */
export function processReferenceAudio(
  inputPath: string,
  options: AudioToolOptions,
): ProcessAudioResult {
  const ffmpeg = resolveFfmpeg(options.ffmpegPath, options.extraCandidates);
  if (!ffmpeg) {
    return { ok: false, error: '未找到 ffmpeg：请在配置中指定 ffmpegPath' };
  }
  const ext = extname(inputPath).toLowerCase();
  const outName = `${randomUUID()}.wav`;
  mkdirSync(options.outputDir, { recursive: true });
  const outPath = join(options.outputDir, outName);
  const tmpPath = `${outPath}.tmp-${process.pid}`;

  const args = [
    '-y',
    '-i',
    inputPath,
    '-af',
    'afftdn=nr=10:nf=-35,highpass=f=60,lowpass=f=14000,silenceremove=start_periods=1:start_threshold=-45dB',
    '-t',
    String(options.maxSeconds),
    '-ar',
    '44100',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    tmpPath,
  ];
  const started = Date.now();
  const result = spawnSync(ffmpeg, args, { windowsHide: true, timeout: 120000, encoding: 'utf8' });
  if (result.error) {
    options.diagnostics.error('tts.audio', `ffmpeg 处理失败: ${result.error.message}`);
    return { ok: false, error: `ffmpeg 执行失败: ${result.error.message}` };
  }
  if (!existsSync(tmpPath)) {
    const stderr = (result.stderr ?? '').slice(-400);
    options.diagnostics.error('tts.audio', `ffmpeg 无输出: ${stderr}`);
    return { ok: false, error: `音频处理失败（格式可能不支持）: ${stderr}` };
  }
  renameSync(tmpPath, outPath);
  const durationMs = probeDuration(ffmpeg, outPath);
  options.diagnostics.info('tts.audio', `参考音频处理完成 ${basename(inputPath)} -> ${outName}`, {
    ...(durationMs !== undefined ? { durationMs } : {}),
    elapsedMs: Date.now() - started,
    source: ext,
  });
  if (durationMs !== undefined && durationMs < options.minSeconds * 1000) {
    options.diagnostics.warn('tts.audio', `片段仅 ${durationMs}ms，短于建议的 ${options.minSeconds}s，音色克隆效果可能不佳`);
  }
  return { ok: true, path: outPath, durationMs };
}

/** 用 ffmpeg 探测 WAV 时长。 */
function probeDuration(ffmpeg: string, path: string): number | undefined {
  const probe = spawnSync(ffmpeg, ['-i', path], {
    windowsHide: true,
    timeout: 15000,
    encoding: 'utf8',
  });
  const stderr = probe.stderr ?? '';
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
}
