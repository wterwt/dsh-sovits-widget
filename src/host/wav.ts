/**
 * 最小 WAV 工具：PCM16 单声道 <-> WAV 容器互转，以及 PCM16 混合。
 * 仅支持插件内部使用的格式（16-bit PCM、1 通道、任意采样率）。
 */

/** 解析 WAV，返回 { sampleRate, pcm16 }。 */
export function parseWav(buffer: Uint8Array): { sampleRate: number; pcm16: Int16Array } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const isRiff =
    (buffer[0] ?? 0) === 0x52 && (buffer[1] ?? 0) === 0x49 && (buffer[2] ?? 0) === 0x46 && (buffer[3] ?? 0) === 0x46; // RIFF
  const isWave =
    (buffer[8] ?? 0) === 0x57 && (buffer[9] ?? 0) === 0x41 && (buffer[10] ?? 0) === 0x56 && (buffer[11] ?? 0) === 0x45; // WAVE
  if (!isRiff || !isWave) throw new Error('不是有效的 WAV 文件');

  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: Uint8Array | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = String.fromCharCode(
      buffer[offset] ?? 0,
      buffer[offset + 1] ?? 0,
      buffer[offset + 2] ?? 0,
      buffer[offset + 3] ?? 0,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + chunkSize > buffer.byteLength) break;
    if (chunkId === 'fmt ') {
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(body, body + chunkSize);
      break;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块');
  if (fmt.bits !== 16) throw new Error(`不支持 ${fmt.bits} 位采样（仅 16-bit PCM）`);
  if (fmt.channels !== 1) throw new Error(`不支持 ${fmt.channels} 声道（仅单声道）`);
  return { sampleRate: fmt.sampleRate, pcm16: new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2) };
}

/** 把 PCM16 封装为 WAV 字节。 */
export function buildWav(pcm16: Int16Array | Uint8Array, sampleRate: number): Uint8Array {
  const samples = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);
  const dataBytes = samples.byteLength;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, dataBytes), 44);
  return out;
}

/** PCM16 -> Float32（-1..1）。 */
export function pcm16ToFloat(pcm16: Int16Array): Float32Array {
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = (pcm16[i] ?? 0) / 32768;
  return out;
}

/** Float32 -> PCM16（限幅，对称量化避免正峰 -1 LSB）。 */
export function floatToPcm16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i] ?? 0));
    const scaled = Math.round(v * 32768);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return out;
}

/**
 * 按比例混合两路 PCM16（音色混合）。
 * @param a 音色 A
 * @param b 音色 B
 * @param ratioA A 的权重（0..1），B 为 1-ratioA；长度以较长者为准，短者尾部补 0。
 */
export function mixPcm16(a: Int16Array, b: Int16Array, ratioA: number): Int16Array {
  const len = Math.max(a.length, b.length);
  const out = new Int16Array(len);
  const rA = Math.max(0, Math.min(1, ratioA));
  const rB = 1 - rA;
  for (let i = 0; i < len; i++) {
    const av = (a[i] ?? 0) / 32768;
    const bv = (b[i] ?? 0) / 32768;
    const mixed = Math.max(-1, Math.min(1, av * rA + bv * rB));
    const scaled = Math.round(mixed * 32768);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return out;
}
