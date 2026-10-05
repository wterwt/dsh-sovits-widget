import { describe, expect, it } from 'vitest';
import { detectEmotion } from '../src/host/emotion.js';

describe('detectEmotion', () => {
  it('识别开心', () => {
    expect(detectEmotion('哈哈，太棒了！恭喜你！')).toBe('happy');
  });

  it('识别愤怒', () => {
    expect(detectEmotion('我气死了，这也太可恶了！')).toBe('angry');
  });

  it('识别悲伤', () => {
    expect(detectEmotion('很抱歉，真的对不起，我也很难过。')).toBe('sad');
  });

  it('多情绪时取命中关键词最多者', () => {
    expect(detectEmotion('气死我了，哈哈，太棒了，哈哈，开心')).toBe('happy');
  });

  it('无情绪词返回 undefined', () => {
    expect(detectEmotion('今天天气晴朗，适合出门。')).toBeUndefined();
  });
});
