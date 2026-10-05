/**
 * 客户端插件入口（IIFE bundle，宿主经 <script> 注入）：
 * - 启动即挂载：悬浮 🔊 FAB、悬浮控制台、配置面板、Toast
 * - 观察 document.body 注入消息级播放按钮（节流扫描，SPA 自愈）
 * - 自动播报：轮询宿主 messages.json，新消息就绪即播放
 * - barge-in：Esc / 发送新消息 → 停止合成并淡出
 * - 健康轮询：降级/恢复时 Toast 提示
 *
 * 注意：不等待聊天界面出现——FAB 与控制台直接挂 body，任何时刻可见可用。
 */

import { api } from './api.js';
import { AudioPlayer } from './player.js';
import { ConsoleUi } from './console-ui.js';
import { ConfigPanel } from './config-panel.js';
import { MessageButtons } from './message-buttons.js';
import { el, injectStyles, toast } from './ui.js';
import { defaultConfig, type RootConfig } from '../host/config.js';

interface WidgetGlobal {
  __dshSovitsWidget?: boolean;
}

declare global {
  interface Window extends WidgetGlobal {}
}

export function boot(): void {
  if (window.__dshSovitsWidget) return;
  window.__dshSovitsWidget = true;

  injectStyles();

  let config: RootConfig | null = null;
  const refreshConfig = async (): Promise<RootConfig | null> => {
    try {
      const res = await api.getConfig();
      config = res.config;
      return res.config;
    } catch {
      return null;
    }
  };

  void (async () => {
    const initial = (await refreshConfig()) ?? defaultConfig();

    // 已播/抑播 seq 状态（自动播报按消息顺序逐条播放）
    let playedSeq = -1;
    let suppressedSeq = -1;

    const player = new AudioPlayer({
      volume: initial.playback.volume,
      fadeOutMs: initial.playback.fadeOutMs,
    });

    const stopPlayback = (): void => {
      player.stop(true);
      void api.stop();
    };

    const consoleUi = new ConsoleUi({
      player,
      onStopAll: stopPlayback,
      onDone: (interrupted) => {
        if (interrupted) suppressedSeq = playedSeq; // 手动停止后不再补播积压消息
      },
    });

    const onConfigSaved = (next: RootConfig): void => {
      config = next;
      player.setVolume(next.playback.volume);
      if (next.playback.autoPlay) startAutoPoll();
      else stopAutoPoll();
    };
    const panel = new ConfigPanel(initial, { onSaved: onConfigSaved });

    // 消息级按钮：直接观察 body（聊天容器结构不明时也能逐步命中）
    const buttons = new MessageButtons({
      player,
      onPlaying: () => {
        consoleUi.setTitle('正在合成…');
        consoleUi.show();
      },
      onStopAll: stopPlayback,
    });
    buttons.attach(document.body);

    // FAB（启动即挂载）
    const fab = el('button', { class: 'dshs-fab', title: 'GPT-SoVITS 语音播报设置' }, ['🔊']);
    fab.dataset.plugin = 'dsh-sovits-widget';
    fab.addEventListener('click', () => panel.open());
    document.body.appendChild(fab);

    // ---- 自动播报轮询（仅 autoPlay 开启时）----
    let autoTimer: ReturnType<typeof setInterval> | null = null;
    const startAutoPoll = (): void => {
      if (autoTimer) return;
      autoTimer = setInterval(() => void pollMessages(), 800);
    };
    const stopAutoPoll = (): void => {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    };
    const pollMessages = async (): Promise<void> => {
      if (!config?.playback.autoPlay) {
        stopAutoPoll();
        return;
      }
      if (player.currentState === 'playing' || player.currentState === 'loading' || player.currentState === 'paused') {
        return; // 已有播报进行中
      }
      try {
        const res = await api.messages(playedSeq);
        const candidates = res.messages
          .filter((m) => m.seq > playedSeq && m.seq > suppressedSeq && m.ready > 0)
          .sort((a, b) => a.seq - b.seq);
        const next = candidates[0];
        if (next) {
          playedSeq = next.seq;
          const status = await api.status(next.messageId);
          const roleName = config?.roles.find((r) => r.id === status.status.activeRoleId)?.name ?? '';
          consoleUi.setRole(roleName);
          consoleUi.show();
          // 边合边播：未完成的段由 player 内部轮询续播
          await player.play(next.messageId, status.status.total);
        }
      } catch {
        // 轮询失败静默重试
      }
    };
    if (initial.playback.autoPlay) startAutoPoll();

    // ---- barge-in：发送新消息 ----
    const onComposerSend = (): void => {
      if (config?.playback.bargeInOnUserMessage) stopPlayback();
    };
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('[data-composer-input], [data-composer-seat], textarea, [contenteditable="true"]'))
      ) {
        onComposerSend();
      }
    });
    const sendObserver = new MutationObserver(() => {
      const sendBtn = document.querySelector<HTMLElement>('[data-send-button], [data-composer-send]');
      if (sendBtn && !sendBtn.hasAttribute('data-dshs-send')) {
        sendBtn.setAttribute('data-dshs-send', '1');
        sendBtn.addEventListener('click', onComposerSend);
      }
    });
    sendObserver.observe(document.body, { childList: true, subtree: true });

    // ---- 健康轮询 + Toast ----
    let lastDegraded: boolean | null = null;
    const pollHealth = (): void => {
      void api.health().then((res) => {
        const degraded = res.health.degraded;
        if (degraded !== lastDegraded) {
          lastDegraded = degraded;
          if (degraded) {
            toast(`GPT-SoVITS 连续失败 ${res.health.consecutiveFailures} 次，已降级到浏览器语音（Web Speech）`, 'warn', 8000);
          } else if (lastDegraded !== null) {
            toast('GPT-SoVITS 已恢复，重新使用自定义音色', 'info');
          }
        }
      });
    };
    setInterval(pollHealth, 30000);

    void api.health().then((res) => {
      lastDegraded = res.health.degraded;
      if (!res.health.ok) {
        toast(
          `GPT-SoVITS 服务未启动（${res.health.lastError ?? '无法连接'}）。请在设置中开启自动拉起，或手动运行 api_v2.py。`,
          'warn',
          9000,
        );
      }
    });
  })();
}

boot();
