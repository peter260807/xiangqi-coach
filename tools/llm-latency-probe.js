/**
 * 实测大模型侧的延迟与 token 消耗 —— 用来和本地引擎 / NNUE 做对比。
 *
 * ⚠️ 会真实调用接口并产生费用，需要先在 web/js/config.js 里填好 apiKey。
 *
 *   node tools/llm-latency-probe.js
 *   node tools/llm-latency-probe.js --coach 10000 --pick 10000
 *
 * 参考结果（deepseek-flash，2026-09-21 实测）：
 *   点评局面  35.3s   输出 6279 token（思维链 6128）  正文 177 字
 *   对弈选着   8.6s   输出 1532 token（思维链 1504）  JSON 正确解析
 *
 * 作为对比：NNUE 单次推理约 21 微秒（纯 numpy，CPU）。
 *
 * 注意两个反复踩到的坑：
 *   1. max_tokens 给不够时，输出会被思维链占满、正文为空，
 *      表现为「功能静默失效」而不是报错。
 *   2. 同一个任务的思维链长度波动很大（1500 ~ 5000+），
 *      所以重试次数要多留一次余量。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const AI = require(path.join(ROOT, 'web/js/ai.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : dflt;
}

const OPENING = ['炮二平五', '马8进7', '马二进三', '车9平8', '车一平二'];

function buildPosition() {
  let b = XQ.parseBoard(XQ.START);
  let side = 'r';
  for (const t of OPENING) {
    const m = XQ.findMoveByLabel(b, side, t);
    if (m) { XQ.makeMove(b, m); side = XQ.other(side); }
  }
  return b;
}

function report(tag, dt, usage, extra) {
  const u = usage || {};
  const reason = u.completion_tokens_details ? u.completion_tokens_details.reasoning_tokens : '?';
  console.log('[' + tag + ']');
  console.log('  耗时      : ' + (dt / 1000).toFixed(1) + 's');
  console.log('  输入 token: ' + (u.prompt_tokens || '?'));
  console.log('  输出 token: ' + (u.completion_tokens || '?') + '（思维链 ' + reason + '）');
  if (extra) console.log(extra);
  console.log('');
}

(async () => {
  const coachTokens = arg('coach', 10000);
  const pickTokens = arg('pick', 10000);

  const b = buildPosition();
  const cands = XQ.topMoves(b, 'b', 4, 5, 2500);
  const eng = XQ.searchRoot(b, 'b', 4, 2000);

  console.log('局面：' + OPENING.join(' ') + ' 后，轮到黑方');
  console.log('引擎候选：' + cands.map(c => c.label + '(' + c.score + ')').join(' '));
  console.log('');

  // ---- 点评 ----
  let t0 = Date.now();
  let coachRetry = '无';
  const r1 = await AI.chat(AI.coachMessages({
    board: b, side: 'b', engineScore: -eng.score,
    candidates: cands.map(c => ({ label: c.label, score: c.score }))
  }), {
    maxTokens: coachTokens,
    onRetry: (n, tk) => { coachRetry = '第 ' + n + ' 次，预算 ' + tk; }
  });
  report('点评局面', Date.now() - t0, r1.usage,
    '  重试      : ' + coachRetry +
    '\n  正文      : ' + ((r1.content || '').trim().length) + ' 字' +
    '\n  ' + (r1.content || '').trim().split('\n')[0].slice(0, 70));

  // ---- 对弈选着 ----
  t0 = Date.now();
  let pickRetry = '无';
  const r2 = await AI.chat(AI.pickMoveMessages({
    board: b, side: 'b',
    candidates: cands.map(c => ({ label: c.label, score: c.score }))
  }), {
    maxTokens: pickTokens, temperature: 0.3,
    onRetry: (n, tk) => { pickRetry = '第 ' + n + ' 次，预算 ' + tk; }
  });
  const obj = AI.extractJson(r2.content);
  report('对弈选着', Date.now() - t0, r2.usage,
    '  重试      : ' + pickRetry +
    '\n  解析结果  : ' + (obj ? JSON.stringify(obj) : '失败（正文为空或格式不对）') +
    '\n  引擎首选  : ' + cands[0].label);

  console.log('=== 对比参考 ===');
  console.log('大模型：秒级');
  console.log('NNUE  ：约 21 微秒（纯 numpy）/ 亚微秒（C++ + SIMD + 增量更新）');
  process.exit(0);
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
