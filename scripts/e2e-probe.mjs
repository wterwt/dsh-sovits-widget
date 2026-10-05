/**
 * 端到端验证：对真实 GPT-SoVITS 服务做协议探测与合成。
 *
 * 用法：
 *   node scripts/e2e-probe.mjs [apiBase] [参考音频路径]
 *   node scripts/e2e-probe.mjs http://127.0.0.1:9880 ref_audio/sample.wav
 *
 * 不传参考音频时只做协议探测，不做合成。
 */

const apiBase = process.argv[2] ?? 'http://127.0.0.1:9880';
const refAudio = process.argv[3] ?? '';

// ---- 1) 协议探测（与 src/host/provider/protocol.ts 同策略：先探根路径）----
console.log(`探测目标: ${apiBase}`);

const root = await fetch(`${apiBase}/?text=%E4%BD%A0%E5%A5%BD&text_language=auto`, {
  method: 'GET',
  signal: AbortSignal.timeout(5000),
}).catch((e) => ({ status: 'ERR', statusText: String(e) }));
console.log(`  GET /      -> ${root.status}`);

let flavor = 'v2';
if (root.status !== 404 && root.status !== 'ERR') {
  flavor = 'legacy';
} else {
  const tts = await fetch(`${apiBase}/tts`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  }).catch((e) => ({ status: 'ERR', statusText: String(e) }));
  console.log(`  GET /tts   -> ${tts.status}`);
  if (tts.status === 404 && root.status === 404) {
    console.log('  两个特征端点均不可达，回退为 v2');
  }
}
console.log(`判定协议: ${flavor}（${flavor === 'v2' ? '新版 api_v2.py' : '旧版 api.py'}）`);

// ---- 2) 健康检查 ----
const ping = await fetch(`${apiBase}/control?command=ping`, {
  method: 'GET',
  signal: AbortSignal.timeout(5000),
}).catch((e) => ({ status: 'ERR', statusText: String(e) }));
console.log(`健康检查 /control -> ${ping.status}`);
if (ping.status === 'ERR' || Number(ping.status) >= 500) {
  console.error('服务不可用，终止。');
  process.exit(1);
}

// ---- 3) 可选：真实合成 ----
if (!refAudio) {
  console.log('\n未提供参考音频参数，仅完成协议与健康检查。');
  console.log('如需合成验证：node scripts/e2e-probe.mjs <apiBase> <参考音频相对路径>');
  process.exit(0);
}

const legacy = flavor === 'legacy';
const url = legacy ? `${apiBase}/` : `${apiBase}/tts`;
const body = legacy
  ? {
      text: '这是一次合成测试。',
      text_language: 'zh',
      refer_wav_path: refAudio,
      prompt_text: '',
      prompt_language: 'zh',
      top_k: 15,
      top_p: 1,
      temperature: 1,
      speed: 1,
      cut_punc: 'cut5',
      inp_refs: [],
    }
  : {
      text: '这是一次合成测试。',
      text_lang: 'zh',
      ref_audio_path: refAudio,
      prompt_text: '',
      prompt_lang: 'zh',
      top_k: 15,
      top_p: 1,
      temperature: 1,
      text_split_method: 'cut5',
      batch_size: 1,
      speed_factor: 1,
      media_type: 'wav',
      streaming_mode: 0,
    };

const started = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000),
});
const buf = new Uint8Array(await res.arrayBuffer());
console.log(`\n合成 POST ${url} -> HTTP ${res.status}  ${buf.byteLength} 字节  ${Date.now() - started}ms`);

if (res.ok && buf.byteLength > 44) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rate = view.getUint32(24, true);
  const dataLen = view.getUint32(40, true);
  console.log(`WAV 校验: ${rate} Hz, ${(dataLen / (rate * 2)).toFixed(2)} 秒`);
  console.log('端到端验证通过');
  process.exit(0);
}
console.log('响应内容:', new TextDecoder().decode(buf.subarray(0, 300)));
process.exit(1);
