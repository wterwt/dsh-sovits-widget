/**
 * 从 dsh 会话事件提取文本（duck-typed，不依赖 @deepseek-ai 包）：
 * - AssistantMessage: { role:'assistant', content: ContentBlock[] }
 *   text 块 → 拼接；其他块（tool-call/reasoning 等）跳过。
 */

interface ContentBlockLike {
  type?: string;
  text?: string;
}

interface MessageLike {
  role?: string;
  content?: ContentBlockLike[];
}

/**
 * 提取助手消息的纯文本（多 text 块以换行连接）。
 */
export function assistantText(message: MessageLike | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * 提取用户消息文本（barge-in 检测用；同样兼容多块）。
 */
export function userText(message: MessageLike | undefined): string {
  return assistantText(message);
}
