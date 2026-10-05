import { describe, expect, it } from 'vitest';
import { cleanText, isSpeakable } from '../src/host/text-cleaner.js';

describe('cleanText', () => {
  it('把代码块替换为（省略代码）', () => {
    const input = '结果如下：\n```js\nconst x = 1;\nconsole.log(x)\n```\n就这么简单。';
    expect(cleanText(input)).toBe('结果如下：\n（省略代码）\n就这么简单。');
  });

  it('把 URL 替换为“链接”', () => {
    expect(cleanText('详见 https://example.com/a?b=1 与 www.foo.cn。')).toBe('详见 链接 与 链接。');
  });

  it('剥离 Markdown 标记保留文字', () => {
    expect(cleanText('**加粗**、*斜体*、[文字](http://x.com)、![图](http://y.com)、`code`。')).toBe(
      '加粗、斜体、文字、图、code。',
    );
  });

  it('移除 emoji 与列表符号', () => {
    expect(cleanText('你好😄！\n- 第一点\n- 第二点')).toBe('你好！\n第一点\n第二点');
  });

  it('解码 HTML 实体并归一化空白', () => {
    expect(cleanText('a &amp; b &lt; c&nbsp;&nbsp;d')).toBe('a & b < c d');
  });

  it('isSpeakable 拒绝纯符号文本', () => {
    expect(isSpeakable('---')).toBe(false);
    expect(isSpeakable('你好。')).toBe(true);
  });
});
