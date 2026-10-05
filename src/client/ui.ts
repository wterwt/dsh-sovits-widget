/**
 * 客户端 UI 工具：DOM 构建、样式注入、Toast、面板外壳。
 */

let styleInjected = false;

/** 注入插件样式（data-plugin 标记防被宿主样式系统误删，同 whale 约定）。 */
export function injectStyles(): void {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
[data-plugin="dsh-sovits-widget"] { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
[data-plugin="dsh-sovits-widget"] *, [data-plugin="dsh-sovits-widget"] *::before, [data-plugin="dsh-sovits-widget"] *::after { box-sizing: border-box; }

.dshs-fab {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 42px; height: 42px; border-radius: 50%;
  background: #2f6bff; color: #fff; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; box-shadow: 0 4px 14px rgba(0,0,0,.25);
  opacity: .85; transition: opacity .15s, transform .15s;
}
.dshs-fab:hover { opacity: 1; transform: scale(1.06); }

.dshs-console {
  position: fixed; right: 16px; bottom: 68px; z-index: 2147483000;
  width: 320px; background: #ffffff; border: 1px solid #e3e6ee;
  border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18);
  padding: 12px 14px; display: none; flex-direction: column; gap: 8px;
}
.dshs-console.dshs-visible { display: flex; }
.dshs-console-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshs-console-title { font-size: 13px; font-weight: 600; color: #1a2233; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshs-console-buttons { display: flex; gap: 6px; }
.dshs-btn {
  border: 1px solid #d6dae5; background: #f5f7fb; color: #2a3245;
  border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; line-height: 1.4;
}
.dshs-btn:hover { background: #e9edf6; }
.dshs-btn.dshs-danger { color: #c0392b; border-color: #f0c4bf; }
.dshs-btn.dshs-primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
.dshs-text-current {
  font-size: 12px; color: #444e63; max-height: 64px; overflow: auto;
  background: #f5f7fb; border-radius: 8px; padding: 6px 8px; line-height: 1.5;
}
.dshs-progress { height: 6px; background: #e9edf6; border-radius: 3px; overflow: hidden; }
.dshs-progress-fill { height: 100%; background: #2f6bff; border-radius: 3px; transition: width .2s; }
.dshs-slider-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #444e63; }
.dshs-slider-row input[type="range"] { flex: 1; }

.dshs-toast-stack { position: fixed; top: 16px; right: 16px; z-index: 2147483100; display: flex; flex-direction: column; gap: 8px; }
.dshs-toast {
  background: #1a2233; color: #fff; border-radius: 10px; padding: 10px 14px;
  font-size: 13px; max-width: 320px; box-shadow: 0 6px 20px rgba(0,0,0,.25);
  animation: dshs-in .18s ease-out;
}
.dshs-toast.dshs-warn { background: #b26a00; }
.dshs-toast.dshs-error { background: #b3302a; }
@keyframes dshs-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

.dshs-panel-mask { position: fixed; inset: 0; z-index: 2147483200; background: rgba(15,20,32,.45); display: none; align-items: flex-start; justify-content: center; overflow: auto; padding: 40px 16px; }
.dshs-panel-mask.dshs-visible { display: flex; }
.dshs-panel {
  background: #ffffff; border-radius: 14px; width: 720px; max-width: 100%;
  box-shadow: 0 16px 60px rgba(0,0,0,.3); padding: 18px 20px;
}
.dshs-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.dshs-panel-title { font-size: 16px; font-weight: 700; color: #1a2233; }
.dshs-tabs { display: flex; gap: 4px; border-bottom: 1px solid #e3e6ee; margin-bottom: 14px; flex-wrap: wrap; }
.dshs-tab { padding: 8px 14px; font-size: 13px; cursor: pointer; color: #55607a; border-bottom: 2px solid transparent; }
.dshs-tab.dshs-active { color: #2f6bff; border-bottom-color: #2f6bff; font-weight: 600; }
.dshs-tab-body { display: none; }
.dshs-tab-body.dshs-active { display: block; }
.dshs-field { margin-bottom: 12px; }
.dshs-field label { display: block; font-size: 12px; color: #55607a; margin-bottom: 4px; }
.dshs-field input[type="text"], .dshs-field input[type="number"], .dshs-field select, .dshs-field textarea {
  width: 100%; border: 1px solid #d6dae5; border-radius: 8px; padding: 7px 10px; font-size: 13px; color: #1a2233; background: #fff;
}
.dshs-field-row { display: flex; gap: 10px; }
.dshs-field-row > .dshs-field { flex: 1; }
.dshs-field textarea { min-height: 64px; resize: vertical; }
.dshs-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #2a3245; margin-bottom: 8px; }
.dshs-check input { width: auto; }
.dshs-role-card { border: 1px solid #e3e6ee; border-radius: 10px; padding: 12px; margin-bottom: 10px; background: #fafbfe; }
.dshs-role-card-head { display: flex; align-items: center; gap: 8px; justify-content: space-between; margin-bottom: 8px; }
.dshs-role-name { font-weight: 700; font-size: 14px; color: #1a2233; }
.dshs-role-card textarea { min-height: 40px; }
.dshs-hint { font-size: 11px; color: #8a93a8; margin-top: 3px; }
.dshs-logs { max-height: 220px; overflow: auto; font-family: ui-monospace, Consolas, monospace; font-size: 11px; background: #f5f7fb; border-radius: 8px; padding: 8px; }
.dshs-log-line { white-space: pre-wrap; word-break: break-all; color: #444e63; }
.dshs-log-line.dshs-warn { color: #b26a00; }
.dshs-log-line.dshs-error { color: #b3302a; }
.dshs-msgbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 6px; border: 1px solid #d6dae5;
  background: #f5f7fb; cursor: pointer; font-size: 12px; color: #2a3245; margin-left: 2px;
  opacity: .8; transition: opacity .12s; vertical-align: middle;
}
.dshs-msgbtn:hover { opacity: 1; background: #e9edf6; }
.dshs-msgbtn.dshs-active { background: #e3ecff; border-color: #9db9f7; color: #2f6bff; }
.dshs-msgbtn-row { display: inline-flex; align-items: center; margin-left: 8px; }
.dshs-badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #e3ecff; color: #2f6bff; margin-left: 6px; }
.dshs-badge.dshs-badge-warn { background: #fdeed3; color: #b26a00; }
`;
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-sovits-widget';
  style.textContent = css;
  document.head.appendChild(style);
}

/** 创建元素。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

let toastStack: HTMLElement | null = null;

/** 显示 Toast（自动消失）。 */
export function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info', ttl = 4200): void {
  if (!toastStack || !document.body.contains(toastStack)) {
    toastStack = el('div', { class: 'dshs-toast-stack' });
    document.body.appendChild(toastStack);
  }
  const node = el('div', { class: `dshs-toast${kind === 'info' ? '' : kind === 'warn' ? ' dshs-warn' : ' dshs-error'}` }, [message]);
  toastStack.appendChild(node);
  setTimeout(() => node.remove(), ttl);
}
