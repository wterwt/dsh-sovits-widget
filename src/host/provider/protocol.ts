/**
 * GPT-SoVITS 服务端协议探测。
 *
 * 两个代际的 HTTP 接口：
 *
 * | 项目         | 旧版 api.py        | 新版 api_v2.py              |
 * | ------------ | ------------------ | --------------------------- |
 * | 合成端点     | POST /             | POST /tts                   |
 * | 参考音频     | refer_wav_path     | ref_audio_path              |
 * | 文本语言     | text_language      | text_lang                   |
 * | 提示语言     | prompt_language    | prompt_lang                 |
 * | 语速         | speed              | speed_factor                |
 * | 切分         | cut_punc           | text_split_method           |
 * | 音色融合     | inp_refs           | aux_ref_audio_paths         |
 * | 切换权重     | /set_model         | /set_gpt_weights + sovits   |
 * | 换参考音频   | /change_refer      | /set_refer_audio            |
 * | 流式         | -sm 启动参数       | 请求体 streaming_mode       |
 *
 * 探测策略：优先探测新版特征端点 `/tts`（GET 会返回 405 或 422 而非 404），
 * 再探测旧版根路径 `/?text=...`。任一失败都回退到新版（当前主流版本）。
 */

export type SovitsFlavor = 'v2' | 'legacy';

export interface ProtocolProbeResult {
  flavor: SovitsFlavor;
  /** 探测依据（写入诊断日志）。 */
  reason: string;
}

/** 探测超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 探测服务端接口代际。
 *
 * 判定依据（实测于 v2ProPlus 整合包）：
 * - 新版 api_v2：`GET /tts` 存在（缺参数返回 422/500），`GET /` 返回 404
 * - 旧版 api.py：`GET /` 存在（缺参数返回 400/200），`GET /tts` 返回 404
 *
 * 先探测根路径：它在新版必然 404，而旧版一定可达，一次请求即可判定，
 * 且不会触发新版 /tts 的参数校验异常。
 *
 * @param apiBase API 基址（无尾斜杠）
 * @param fetchImpl fetch 实现
 * @param signal 外部取消信号
 */
export async function probeFlavor(
  apiBase: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProtocolProbeResult> {
  // 1) 根路径：旧版 api.py 的合成端点在 `/`；新版没有该路由（404）
  try {
    const res = await fetchImpl(`${apiBase}/?text=%E4%BD%A0%E5%A5%BD&text_language=auto`, {
      method: 'GET',
      signal: combine(signal, PROBE_TIMEOUT_MS),
    });
    if (res.status !== 404) {
      return { flavor: 'legacy', reason: `根路径存在（HTTP ${res.status}），判定旧版 api.py` };
    }
  } catch {
    // 网络异常：交由健康检查处理，此处按新版继续
    return { flavor: 'v2', reason: '探测请求失败，按新版 api_v2 处理' };
  }

  // 2) 新版特征端点 /tts：存在则确认新版
  try {
    const res = await fetchImpl(`${apiBase}/tts`, {
      method: 'GET',
      signal: combine(signal, PROBE_TIMEOUT_MS),
    });
    if (res.status !== 404) {
      return { flavor: 'v2', reason: `/tts 端点存在（HTTP ${res.status}），判定新版 api_v2` };
    }
  } catch {
    // 忽略，走默认
  }

  return { flavor: 'v2', reason: '两个特征端点均不可达，按新版 api_v2 处理' };
}

/** 合并外部信号与超时。 */
function combine(signal: AbortSignal | undefined, ms: number): AbortSignal {
  if (!signal) return AbortSignal.timeout(ms);
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}
