import { describe, expect, it } from 'vitest';
import { segmentText } from '../src/host/text-segmenter.js';

describe('segmentText', () => {
  it('按句末标点切分', () => {
    const segs = segmentText('你好！今天天气不错；我们出发吧。');
    expect(segs.map((s) => s.text)).toEqual(['你好！', '今天天气不错；', '我们出发吧。']);
  });

  it('按换行切块', () => {
    const segs = segmentText('第一行\n第二行。');
    expect(segs.map((s) => s.text)).toEqual(['第一行', '第二行。']);
  });

  it('超长句在逗号处二次切分', () => {
    const long = '这是一段特别长的句子，包含了逗号分隔，需要被合理地切成多段，保证每段不超过上限。';
    const segs = segmentText(long, 20);
    for (const seg of segs) expect(seg.text.length).toBeLessThanOrEqual(20);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.map((s) => s.text).join('')).toBe(long);
  });

  it('无标点超长文本硬切且不断开拉丁串', () => {
    const long = 'abcdefghij'.repeat(6); // 60 chars
    const segs = segmentText(long, 25);
    for (const seg of segs) {
      expect(seg.text.length).toBeLessThanOrEqual(25);
      expect(seg.text).toMatch(/^[a-z]+$/);
    }
  });

  it('段序号连续且可携带情感标签', () => {
    const segs = segmentText('好开心呀！真的太棒了。', 50, 'happy');
    expect(segs[0]?.index).toBe(0);
    expect(segs[1]?.index).toBe(1);
    expect(segs[0]?.emotion).toBe('happy');
  });

  it('空文本返回空数组', () => {
    expect(segmentText('  \n  ')).toEqual([]);
  });
});
