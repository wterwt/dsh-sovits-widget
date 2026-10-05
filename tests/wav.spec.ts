import { describe, expect, it } from 'vitest';
import { buildWav, floatToPcm16, mixPcm16, parseWav, pcm16ToFloat } from '../src/host/wav.js';

function makeWav(pcm: Int16Array, rate = 32000): Uint8Array {
  return buildWav(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), rate);
}

describe('wav 工具', () => {
  it('buildWav/parseWav 往返一致', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32000, -32000, 7]);
    const wav = makeWav(pcm, 32000);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(32000);
    expect(Array.from(parsed.pcm16)).toEqual(Array.from(pcm));
  });

  it('parseWav 拒绝非 WAV', () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3, 4]))).toThrow(/WAV/);
  });

  it('pcm16ToFloat/floatToPcm16 往返', () => {
    const f = pcm16ToFloat(new Int16Array([-32768, 0, 32767]));
    expect(f[0]).toBeCloseTo(-1);
    expect(f[1]).toBe(0);
    expect(f[2]).toBeCloseTo(1);
    const back = floatToPcm16(f);
    expect(back[0]).toBe(-32768);
    expect(back[2]).toBe(32767);
  });

  it('mixPcm16 按比例混合', () => {
    const a = new Int16Array([32767, 0]);
    const b = new Int16Array([0, 32767]);
    const mixed = mixPcm16(a, b, 0.7);
    expect(mixed[0]).toBeCloseTo(22938, -1); // 32767*0.7
    expect(mixed[1]).toBeCloseTo(9830, -1); // 32767*0.3
  });

  it('mixPcm16 处理不等长（短者补零）', () => {
    const a = new Int16Array([32767, 32767, 32767]);
    const b = new Int16Array([0]);
    const mixed = mixPcm16(a, b, 1);
    expect(mixed.length).toBe(3);
    expect(mixed[0]).toBe(32767);
    expect(mixed[2]).toBe(32767);
  });
});
