/**
 * 文本清洗（TextCleaner）：把 LLM 输出转为适合朗读的纯口语文本。
 * - 代码块（``` 围栏与缩进块）→ （省略代码）
 * - Markdown 链接/图片/粗斜体/标题/列表符号/引用符号 → 去掉标记留文字
 * - URL → “链接”
 * - Emoji 与杂类符号 → 移除（保留 CJK 标点用于分段）
 * - HTML 实体与多余空白 → 归一化
 */

const CODE_FENCE = /```[\s\S]*?```/g;
const CODE_TILDE = /~~~[\s\S]*?~~~/g;
/** 缩进代码块：连续 2+ 行以 4 空格或制表符开头。 */
const CODE_INDENT = /^(?: {4}|\t)[^\n]*(\n(?: {4}|\t)[^\n]*)+/gm;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]」。！？；，、]+/gi;
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
/** 非朗读内容的杂类符号（保留 CJK/ASCII 标点、字母数字、空格）。 */
const NOISE_RE = /[*_~`>#|]+/g;
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-fA-F]+);/g;

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 匹配占位符号词（emoji 之外的杂类，如 ✅❌ 已由 EMOJI_RE 覆盖）。 */

/**
 * 清洗 LLM 文本为可朗读口语文本。
 * @param input 原始助手回复（含 Markdown）。
 */
export function cleanText(input: string): string {
  let text = input;

  text = text.replace(CODE_FENCE, '（省略代码）');
  text = text.replace(CODE_TILDE, '（省略代码）');
  text = text.replace(CODE_INDENT, '（省略代码）');
  text = text.replace(URL_RE, '链接');
  // Markdown 链接：[文字](url) -> 文字；图片 ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(HTML_ENTITY_RE, (m) => {
    const inner = m.slice(1, -1);
    if (inner.startsWith('#x')) return String.fromCodePoint(parseInt(inner.slice(2), 16));
    if (inner.startsWith('#')) return String.fromCodePoint(parseInt(inner.slice(1), 10));
    return ENTITY_MAP[inner] ?? '';
  });
  text = text.replace(EMOJI_RE, '');
  text = text.replace(NOISE_RE, '');
  // 列表符号、破折号列表等
  text = text.replace(/^\s*[-•·]\s+/gm, '');
  // 多空行/空格归一化
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{2,}/g, '\n');
  text = text.trim();
  return text;
}

/**
 * 判断清洗后是否仍值得朗读。
 */
export function isSpeakable(text: string): boolean {
  const t = cleanText(text);
  // 至少包含一个字母/数字/CJK 字符
  return /[\p{L}\p{N}]/u.test(t) && t.length > 0;
}
