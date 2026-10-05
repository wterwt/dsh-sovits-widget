/**
 * 消息级操作按钮：在每条助手回复下方注入 播放/重新生成语音/停止 小图标。
 * 通过 MutationObserver 持续扫描消息容器（SPA 路由切换自愈），
 * 文本从消息 DOM 提取，点击后交给宿主合成并播放。
 */

import { api } from './api.js';
import { AudioPlayer } from './player.js';
import { el, toast } from './ui.js';

export interface MessageButtonsOptions {
  player: AudioPlayer;
  onPlaying?: (messageId: string) => void;
  onStopAll?: () => void;
}

const PROCESSED_ATTR = 'data-dshs-buttons';

/** 助手消息容器选择器候选（不同版本 UI 结构兜底）。 */
const MESSAGE_SELECTORS = [
  '[data-message-id]',
  '[data-message-role="assistant"]',
  '[data-role="assistant"]',
  '[data-turn-role="assistant"]',
];

export class MessageButtons {
  private readonly player: AudioPlayer;
  private readonly options: MessageButtonsOptions;
  private observer: MutationObserver | null = null;
  private playingMessageId: string | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MessageButtonsOptions) {
    this.player = options.player;
    this.options = options;
  }

  /** 开始观察（通常直接观察 body；节流扫描避免高频 DOM 变更拖慢页面）。 */
  attach(container: HTMLElement): void {
    this.scan(container);
    this.observer = new MutationObserver(() => this.scheduleScan(container));
    this.observer.observe(container, { childList: true, subtree: true });
  }

  /** 节流：DOM 变更后最多每 300ms 扫一次。 */
  private scheduleScan(container: HTMLElement): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan(container);
    }, 300);
  }

  private scan(container: HTMLElement): void {
    let targets: HTMLElement[] = [];
    for (const selector of MESSAGE_SELECTORS) {
      targets = Array.from(container.querySelectorAll<HTMLElement>(selector));
      if (targets.length > 0) break;
    }
    // 容器自身也可能是消息根
    if (targets.length === 0 && container.matches(MESSAGE_SELECTORS.join(','))) targets = [container];

    for (const root of targets) {
      // 跳过系统/通知类短行与已处理节点
      if (root.hasAttribute(PROCESSED_ATTR)) continue;
      const text = this.extractText(root);
      if (text.trim().length < 2) continue;
      root.setAttribute(PROCESSED_ATTR, '1');
      this.injectButtons(root, text);
    }
  }

  private extractText(root: HTMLElement): string {
    // 取内容容器文本；排除我们注入的按钮行
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-dshs-buttons-row]').forEach((n) => n.remove());
    const content =
      clone.querySelector('[data-message-content]') ??
      clone.querySelector('.markdown-body') ??
      clone.querySelector('.prose') ??
      clone;
    return (content.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  }

  private injectButtons(root: HTMLElement, text: string): void {
    const row = el('span', { class: 'dshs-msgbtn-row', 'data-dshs-buttons-row': '1' });
    row.dataset.plugin = 'dsh-sovits-widget';

    const playBtn = el('button', { class: 'dshs-msgbtn', title: '播放/朗读' }, ['▶']);
    const regenBtn = el('button', { class: 'dshs-msgbtn', title: '重新生成语音' }, ['↻']);
    const stopBtn = el('button', { class: 'dshs-msgbtn', title: '停止播报' }, ['⏹']);
    row.append(playBtn, regenBtn, stopBtn);

    const setActive = (active: boolean): void => {
      playBtn.classList.toggle('dshs-active', active);
    };

    const speakAndPlay = (): void => {
      if (this.playingMessageId) {
        this.player.stop(true);
        void api.stop(this.playingMessageId);
        this.playingMessageId = null;
        setActive(false);
      }
      void (async () => {
        try {
          const res = await api.speak(text);
          this.playingMessageId = res.messageId;
          this.options.onPlaying?.(res.messageId);
          setActive(true);
          await this.player.play(res.messageId, 0);
          setActive(false);
          this.playingMessageId = null;
        } catch (err) {
          toast(`播报失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
          setActive(false);
          this.playingMessageId = null;
        }
      })();
    };

    playBtn.addEventListener('click', () => {
      if (this.playingMessageId && this.player.currentState !== 'idle' && this.player.currentState !== 'stopped') {
        this.player.stop(true);
        void api.stop(this.playingMessageId);
        this.playingMessageId = null;
        setActive(false);
      } else {
        speakAndPlay();
      }
    });
    regenBtn.addEventListener('click', speakAndPlay);
    stopBtn.addEventListener('click', () => {
      this.player.stop(true);
      this.options.onStopAll?.();
      setActive(false);
      this.playingMessageId = null;
    });

    // 挂到消息内容尾部（有内容容器则挂容器末尾，否则消息根末尾）
    const anchor =
      root.querySelector('[data-message-content]') ??
      root.querySelector('.markdown-body') ??
      root.querySelector('.prose') ??
      root;
    anchor.appendChild(row);
  }
}
