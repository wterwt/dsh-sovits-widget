/**
 * 悬浮控制台（播放时显示）：进度条、当前朗读文本高亮、暂停/停止、
 * 语速调节、静音快捷键提示。Esc = 停止（barge-in）。
 */

import { AudioPlayer } from './player.js';
import { el } from './ui.js';

export interface ConsoleUiOptions {
  player: AudioPlayer;
  /** 播放速度设置回调（AudioContext 重采样由宿主合成 speed_factor 控制，这里仅做播放倍速）。 */
  onSpeedChange?: (rate: number) => void;
  onStopAll?: () => void;
  /** 播放结束/被停止时回调（interrupted=true 表示被打断）。 */
  onDone?: (interrupted: boolean) => void;
}

export class ConsoleUi {
  private readonly player: AudioPlayer;
  private readonly options: ConsoleUiOptions;
  private root: HTMLElement;
  private textEl!: HTMLElement;
  private progressFill!: HTMLElement;
  private titleEl!: HTMLElement;
  private playPauseBtn!: HTMLButtonElement;
  private speedInput!: HTMLInputElement;
  private roleLabel!: HTMLElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ConsoleUiOptions) {
    this.options = options;
    this.player = options.player;
    this.root = this.build();
    document.body.appendChild(this.root);
    this.bindPlayer();
    this.bindKeys();
  }

  show(): void {
    this.root.classList.add('dshs-visible');
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }

  setRole(name: string): void {
    this.roleLabel.textContent = name ? `音色：${name}` : '';
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  private build(): HTMLElement {
    const root = el('div', { class: 'dshs-console' });
    root.dataset.plugin = 'dsh-sovits-widget';
    this.playPauseBtn = el('button', { class: 'dshs-btn', title: '暂停/继续' }, ['⏸']);
    const stopBtn = el('button', { class: 'dshs-btn dshs-danger', title: '停止播报 (Esc)' }, ['⏹']);
    this.titleEl = el('div', { class: 'dshs-console-title' }, ['语音播报']);
    this.roleLabel = el('span', { class: 'dshs-badge' }, ['']);
    const head = el('div', { class: 'dshs-console-head' }, [
      el('div', { class: 'dshs-console-title' }, [this.titleEl, this.roleLabel]),
      el('div', { class: 'dshs-console-buttons' }, [this.playPauseBtn, stopBtn]),
    ]);
    this.textEl = el('div', { class: 'dshs-text-current' }, ['准备合成…']);
    const progress = el('div', { class: 'dshs-progress' });
    this.progressFill = el('div', { class: 'dshs-progress-fill' });
    progress.appendChild(this.progressFill);
    this.speedInput = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: '1' }) as HTMLInputElement;
    const speedRow = el('div', { class: 'dshs-slider-row' }, [el('span', {}, ['语速']), this.speedInput]);
    root.append(head, this.textEl, progress, speedRow);

    this.playPauseBtn.addEventListener('click', () => {
      if (this.player.currentState === 'paused') {
        this.player.resume();
        this.playPauseBtn.textContent = '⏸';
      } else {
        this.player.pause();
        this.playPauseBtn.textContent = '▶';
      }
    });
    stopBtn.addEventListener('click', () => {
      this.player.stop(true);
      this.options.onStopAll?.();
      this.scheduleHide(600);
    });
    this.speedInput.addEventListener('input', () => {
      this.options.onSpeedChange?.(Number(this.speedInput.value));
    });
    return root;
  }

  private bindPlayer(): void {
    this.player.setEvents({
      onSegmentStart: (_index: number, text: string): void => {
        this.show();
        this.textEl.textContent = text;
        this.textEl.scrollTop = 0;
      },
      onProgress: (played: number, total: number): void => {
        this.progressFill.style.width = total > 0 ? `${(played / total) * 100}%` : '0%';
      },
      onStateChange: (state): void => {
        if (state === 'playing' || state === 'loading') this.show();
        if (state === 'paused') this.playPauseBtn.textContent = '▶';
        if (state === 'playing') this.playPauseBtn.textContent = '⏸';
      },
      onDone: (interrupted: boolean): void => {
        if (!interrupted) this.scheduleHide(1200);
        this.options.onDone?.(interrupted);
      },
    });
  }

  private scheduleHide(delay: number): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.root.classList.remove('dshs-visible');
    }, delay);
  }

  private bindKeys(): void {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return; // 输入框内 Esc 不拦截
      }
      if (this.player.currentState !== 'idle' && this.player.currentState !== 'stopped') {
        event.preventDefault();
        event.stopPropagation();
        this.player.stop(true);
        this.options.onStopAll?.();
        this.scheduleHide(600);
      }
    });
  }
}
