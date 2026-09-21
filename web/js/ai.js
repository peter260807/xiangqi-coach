/* 大模型客户端 —— 默认对接 DeepSeek，但接口/模型/参数全部可配置
 * 浏览器与 Node 均可加载（Node 下用内置 fetch，Node 18+ 支持）。
 */
(function (root) {
  'use strict';

  var STORE_KEY = 'xq.ai.config.v1';
  var DEFAULTS = {};
  if (root.XQ_CONFIG) DEFAULTS = root.XQ_CONFIG;
  else if (typeof require !== 'undefined') {
    /* config.js 是可选的本地配置（已 gitignore），缺失时不影响加载 */
    try { DEFAULTS = require('./config.js') || {}; } catch (e) { DEFAULTS = {}; }
  }
  if (!DEFAULTS.baseUrl) {
    DEFAULTS.baseUrl = 'https://api.deepseek.com';
    DEFAULTS.model = DEFAULTS.model || 'deepseek-flash';
    DEFAULTS.temperature = 0.6;
    DEFAULTS.maxTokens = 50000;
    DEFAULTS.timeoutMs = 180000;
  }
  DEFAULTS.apiKey = DEFAULTS.apiKey || '';

  var memoryStore = null;

  function readStore() {
    if (memoryStore) return memoryStore;
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem(STORE_KEY);
        memoryStore = raw ? JSON.parse(raw) : {};
      } else memoryStore = {};
    } catch (e) { memoryStore = {}; }
    return memoryStore;
  }

  function writeStore(obj) {
    memoryStore = obj;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch (e) { /* 隐私模式等场景静默降级为内存存储 */ }
  }

  function getConfig() {
    var saved = readStore();
    var out = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    for (var k2 in saved) if (Object.prototype.hasOwnProperty.call(saved, k2)) out[k2] = saved[k2];
    return out;
  }

  function saveConfig(patch) {
    var cur = readStore();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
    writeStore(cur);
    return getConfig();
  }

  function resetConfig() {
    memoryStore = {};
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_KEY); } catch (e) {}
    return getConfig();
  }

  function isConfigured() {
    var c = getConfig();
    return !!(c.apiKey && c.baseUrl && c.model);
  }

  function endpoint(path) {
    var base = String(getConfig().baseUrl || '').replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return path === 'models' ? base.replace(/\/chat\/completions$/, '/models') : base;
    return base + (path === 'models' ? '/models' : '/chat/completions');
  }

  /* ---------- 核心请求 ---------- */

  function chat(messages, opts) {
    opts = opts || {};
    var cfg = getConfig();
    if (!cfg.apiKey) return Promise.reject(new Error('\u5c1a\u672a\u914d\u7f6e API Key\uff0c\u8bf7\u5148\u5728\u300c\u8bbe\u7f6e\u300d\u91cc\u586b\u5199\u3002'));

    var stream = typeof opts.onDelta === 'function' || typeof opts.onReasoning === 'function';
    var baseTokens = opts.maxTokens || cfg.maxTokens;
    // 默认给 3 次机会。推理模型的思维链长度波动很大 —— 同一个任务有时烧
    // 5000 token，有时上万；只给 2 次的话，2500 -> 5000 就到顶了，
    // 遇到"想得久"的局面照样会正文为空。max_tokens 只是上限、
    // 不按它计费，所以多留一次兜底不会增加成本。
    var maxTries = Math.max(1, opts.attempts || 3);
    var tries = 0;

    function attempt(tokens, forcePlain) {
      var useStream = stream && !forcePlain;
      var body = {
        model: opts.model || cfg.model,
        messages: messages,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : cfg.temperature,
        max_tokens: tokens,
        stream: useStream
      };
      if (useStream) body.stream_options = { include_usage: true };

      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, cfg.timeoutMs);
      var headers = { 'Content-Type': 'application/json' };
      headers['Authorization'] = 'Bearer ' + cfg.apiKey;

      return fetch(endpoint('chat'), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var msg = 'HTTP ' + res.status;
            try {
              var j = JSON.parse(t);
              if (j.error && j.error.message) msg += '\uff1a' + j.error.message;
            } catch (e) { msg += '\uff1a' + String(t).slice(0, 200); }
            throw new Error(msg);
          });
        }
        if (!useStream) {
          return res.json().then(function (j) {
            var ch = (j.choices && j.choices[0]) || {};
            return {
              content: (ch.message && ch.message.content) || '',
              reasoning: (ch.message && ch.message.reasoning_content) || '',
              usage: j.usage || null,
              model: j.model || body.model,
              finishReason: ch.finish_reason || null,
              truncated: ch.finish_reason === 'length'
            };
          });
        }
        /* 个别浏览器/环境拿不到流式响应体，退回一次性响应，保证功能可用 */
        return readStream(res, opts).catch(function (err) {
          if (err && err.name === 'AbortError') throw err;
          if (opts.onFallback) opts.onFallback();
          return attempt(tokens, true);
        });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') throw new Error('\u8bf7\u6c42\u8d85\u65f6\u6216\u5df2\u53d6\u6d88\uff08\u5f53\u524d\u4e0a\u9650 ' + Math.round(cfg.timeoutMs / 1000) + ' \u79d2\uff09');
        if (err instanceof TypeError) throw new Error('\u65e0\u6cd5\u8fde\u63a5\u5230 ' + cfg.baseUrl + '\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u548c\u63a5\u53e3\u5730\u5740\u3002');
        throw err;
      }).finally(function () { clearTimeout(timer); });
    }

    /* 推理模型会把思维链算进 max_tokens，偶尔正文被挤没。
       这里检测到「只有思维链没有正文」时自动加倍预算重试。

       注意上面那个上限原先是写死的 16000 —— **那才是真正的瓶颈**：
       设置里把 max_tokens 调多大，都会被它压回 16000。
       现在只留一个远高于各家上限的天花板；服务端嫌 max_tokens 太大时
       （各家上限差别很大，8K / 16K / 64K 都有）退化到保守值再试一次，
       而不是让整个功能直接报错。 */
    var CEILING = 200000, SAFE_TOKENS = 8192;
    function run(forced) {
      tries++;
      var tokens = forced || Math.min(baseTokens * Math.pow(2, tries - 1), CEILING);
      return attempt(tokens).then(function (r) {
        r.maxTokensUsed = tokens;
        var hasText = !!(r.content && r.content.trim());
        var hasReason = !!(r.reasoning && r.reasoning.trim());
        if (!hasText && hasReason && tries < maxTries) {
          if (opts.onRetry) opts.onRetry(tries, tokens);
          return run();
        }
        r.retried = tries - 1;
        return r;
      }, function (err) {
        var m = String((err && err.message) || '');
        if (!forced && m.indexOf('HTTP 400') === 0 && m.indexOf('max_tokens') >= 0) {
          return run(SAFE_TOKENS);
        }
        throw err;
      });
    }
    return run();
  }

  function readStream(res, opts) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', content = '', reasoning = '', usage = null, finishReason = null;

    function handle(raw) {
      var s = raw.trim();
      if (!s || s.charAt(0) === ':') return;
      if (s.indexOf('data:') !== 0) return;
      var payload = s.slice(5).trim();
      if (payload === '[DONE]') return;
      var j;
      try { j = JSON.parse(payload); } catch (e) { return; }
      if (j.usage) usage = j.usage;
      var ch = j.choices && j.choices[0];
      if (ch && ch.finish_reason) finishReason = ch.finish_reason;
      var d = ch && ch.delta;
      if (!d) return;
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        if (opts.onReasoning) opts.onReasoning(d.reasoning_content, reasoning);
      }
      if (d.content) {
        content += d.content;
        if (opts.onDelta) opts.onDelta(d.content, content);
      }
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          if (buf) handle(buf);
          return {
            content: content, reasoning: reasoning, usage: usage,
            finishReason: finishReason, truncated: finishReason === 'length'
          };
        }
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split('\n');
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) handle(parts[i]);
        return pump();
      });
    }
    return pump();
  }

  function listModels() {
    var cfg = getConfig();
    var headers = { 'Authorization': 'Bearer ' + cfg.apiKey };
    return fetch(endpoint('models'), { headers: headers }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (j) {
      return (j.data || []).map(function (m) { return m.id; });
    });
  }

  function testConnection() {
    var t0 = Date.now();
    return chat([{ role: 'user', content: '\u56de\u590d\u4e24\u4e2a\u5b57\uff1a\u6b63\u5e38' }], { maxTokens: 600, temperature: 0 })
      .then(function (r) {
        return {
          ok: true,
          ms: Date.now() - t0,
          reply: (r.content || '').trim(),
          reasoningTokens: (r.usage && r.usage.completion_tokens_details && r.usage.completion_tokens_details.reasoning_tokens) || 0,
          usage: r.usage
        };
      });
  }

  /* ---------- 提示词 ---------- */

  var NAME_MAP = {
    K: '\u5e05', A: '\u4ed5', B: '\u76f8', N: '\u9a6c', R: '\u8f66', C: '\u70ae', P: '\u5175',
    k: '\u5c06', a: '\u58eb', b: '\u8c61', n: '\u9a6c', r: '\u8f66', c: '\u70ae', p: '\u5352'
  };

  function boardAscii(board) {
    var out = ['     a  b  c  d  e  f  g  h  i'];
    for (var r = 0; r < 10; r++) {
      var row = ' ' + (9 - r) + '   ';
      for (var c = 0; c < 9; c++) {
        var p = board[r * 9 + c];
        row += (p === '.' ? '\u00b7' : NAME_MAP[p]) + '  ';
      }
      out.push(row);
    }
    out.push('     a  b  c  d  e  f  g  h  i');
    out.push('\uff08\u7ea2\u65b9\u5728\u4e0b\uff08\u7b2c 9 \u884c\uff09\uff0c\u9ed1\u65b9\u5728\u4e0a\uff08\u7b2c 0 \u884c\uff09\uff1b\u5b57\u6bcd\u4e3a\u7eb5\u7ebf\uff0c\u6570\u5b57\u4e3a\u6a2a\u7ebf\uff09');
    return out.join('\n');
  }

  var SYSTEM_COACH =
    '\u4f60\u662f\u4e00\u4f4d\u4e2d\u56fd\u8c61\u68cb\u6559\u7ec3\uff0c\u9762\u5411\u521d\u5b66\u8005\u8bb2\u89e3\u3002' +
    '\u56de\u7b54\u8981\u6c42\uff1a\u53ea\u8bb2\u6700\u5173\u952e\u7684\u4e1c\u897f\uff1b\u7528\u7b80\u4f53\u4e2d\u6587\uff1b' +
    '\u4e0d\u5806\u780c\u672f\u8bed\uff0c\u6bcf\u4e2a\u672f\u8bed\u9996\u6b21\u51fa\u73b0\u65f6\u7528\u4e00\u53e5\u8bdd\u89e3\u91ca\uff1b' +
    '\u6d89\u53ca\u5177\u4f53\u7740\u6cd5\u65f6\u5fc5\u987b\u7528\u6807\u51c6\u4e2d\u6587\u68cb\u8c31\u8bb0\u6cd5\uff08\u5982\u300c\u70ae\u4e8c\u5e73\u4e94\u300d\u3001\u300c\u9a6c\u516b\u8fdb\u4e03\u300d\uff09\u3002';

  function positionBrief(ctx) {
    var lines = [];
    lines.push('\u3010\u5f53\u524d\u5c40\u9762\u3011');
    lines.push(boardAscii(ctx.board));
    lines.push('');
    lines.push('\u5230\u8c01\u8d70\uff1a' + (ctx.side === 'r' ? '\u7ea2\u65b9' : '\u9ed1\u65b9'));
    if (ctx.moveText) lines.push('\u5df2\u8d70\u7740\u6cd5\uff1a' + ctx.moveText);
    if (ctx.engineScore !== undefined && ctx.engineScore !== null) {
      lines.push('\u672c\u5730\u5f15\u64ce\u8bc4\u4f30\uff08\u7ea2\u65b9\u89c6\u89d2\uff0c\u5355\u4f4d\u5398\u5175\uff0c\u6b63\u6570\u7ea2\u4f18\uff09\uff1a' + ctx.engineScore);
    }
    if (ctx.candidates && ctx.candidates.length) {
      lines.push('\u5f15\u64ce\u7b5b\u9009\u51fa\u7684\u5019\u9009\u7740\u6cd5\uff08\u5df2\u9a8c\u8bc1\u5408\u6cd5\uff09\uff1a');
      ctx.candidates.forEach(function (c, i) {
        lines.push('  ' + (i + 1) + '. ' + c.label + '\uff08\u8bc4\u4f30 ' + c.score + '\uff09');
      });
    }
    if (ctx.inCheck) lines.push('\u6ce8\u610f\uff1a\u5f53\u524d\u6709\u4e00\u65b9\u6b63\u88ab\u5c06\u519b\u3002');
    return lines.join('\n');
  }

  function coachMessages(ctx, question) {
    var user = positionBrief(ctx);
    if (question) user += '\n\n\u3010\u68cb\u53cb\u63d0\u95ee\u3011' + question;
    else user += '\n\n\u3010\u4efb\u52a1\u3011\u70b9\u8bc4\u8fd9\u4e2a\u5c40\u9762\uff0c\u544a\u8bc9\u6211\u73b0\u5728\u8be5\u600e\u4e48\u60f3\u3001' +
      '\u63a8\u8350\u8d70\u54ea\u4e00\u6b65\u3001\u4e3a\u4ec0\u4e48\u3002\u4e0d\u8981\u8d85\u8fc7 220 \u5b57\u3002';
    return [
      { role: 'system', content: SYSTEM_COACH },
      { role: 'user', content: user }
    ];
  }

  function reviewMessages(ctx) {
    var lines = [];
    lines.push('\u3010\u5bf9\u5c40\u8bb0\u5f55\u3011');
    lines.push(ctx.moveText || '\uff08\u65e0\uff09');
    lines.push('');
    lines.push('\u3010\u7ed3\u679c\u3011' + (ctx.result || '\u672a\u7ed3\u675f'));
    if (ctx.evalTrace && ctx.evalTrace.length) {
      lines.push('');
      lines.push('\u3010\u5f15\u64ce\u8bc4\u4f30\u53d8\u5316\u3011\uff08\u6bcf\u56de\u5408\u7ea2\u65b9\u89c6\u89d2\uff09');
      lines.push(ctx.evalTrace.join('\uff0c'));
    }
    if (ctx.startFen && ctx.endFen) {
      lines.push('');
      lines.push('\u3010\u7ec8\u5c40\u9762\u3011');
      lines.push(boardAscii(ctx.endBoard));
    }
    lines.push('');
    lines.push('\u3010\u4efb\u52a1\u3011\u505a\u4e00\u4efd\u590d\u76d8\u62a5\u544a\uff0c\u7528\u5c0f\u6807\u9898\u5206\u6210\u4e09\u6bb5\uff1a');
    lines.push('1. \u5f00\u5c40\uff1a\u5e03\u5c40\u662f\u5426\u5408\u7406\uff0c\u6709\u6ca1\u6709\u660e\u663e\u5931\u5148\u624b\uff1b');
    lines.push('2. \u4e2d\u5c40\uff1a\u627e\u51fa 1\uff5e2 \u4e2a\u5173\u952e\u8f6c\u6298\u70b9\uff0c\u6307\u51fa\u5177\u4f53\u54ea\u4e00\u7740\u8d70\u9519\u4e86\u3001\u5e94\u8be5\u8d70\u4ec0\u4e48\uff1b');
    lines.push('3. \u603b\u7ed3\uff1a\u7ed9 2\uff5e3 \u6761\u53ef\u4ee5\u9a6c\u4e0a\u7ec3\u4e60\u7684\u6539\u8fdb\u5efa\u8bae\u3002');
    lines.push('\u5168\u6587\u4e0d\u8981\u8d85\u8fc7 500 \u5b57\u3002');
    return [
      { role: 'system', content: SYSTEM_COACH + '\u4f60\u6b63\u5728\u505a\u8d5b\u540e\u590d\u76d8\u3002' },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  /* 混合对弈用：着法由引擎定，这里只让模型解释「为什么走这一步」。
     为什么不再让模型挑：候选和评分本来就是引擎算出来的，模型「挑」并不更懂，
     反而可能因为理由好听而选次优着法；而且 JSON 输出遇到思维链吃满 token 会
     解析失败、静默回退（实测就踩到了）。改成纯文本解释之后，
     输出更短、失败风险归零，理由也必然和实际走的棋一致。 */
  function explainMoveMessages(ctx) {
    var lines = [];
    lines.push('\u3010\u5c40\u9762\u3011');
    lines.push(boardAscii(ctx.board));
    lines.push('');
    lines.push('\u4f60\u6267' + (ctx.side === 'r' ? '\u7ea2' : '\u9ed1') + '\u65b9\u3002');
    lines.push('');
    lines.push('\u3010\u51b3\u5b9a\u8d70\u7684\u8fd9\u4e00\u6b65\u3011' +
      ctx.move + '\uff08\u5f15\u64ce\u8bc4\u4f30 ' + ctx.score + '\uff09');
    if (ctx.alternatives && ctx.alternatives.length) {
      lines.push('');
      lines.push('\u3010\u5f15\u64ce\u4e5f\u8003\u8651\u8fc7\u4f46\u6ca1\u9009\u7684\u3011');
      ctx.alternatives.forEach(function (c) {
        lines.push('  ' + c.label + '\uff08\u5f15\u64ce\u8bc4\u4f30 ' + c.score + '\uff09');
      });
    }
    lines.push('');
    lines.push('\u3010\u4efb\u52a1\u3011\u7528\u4e24\u4e09\u53e5\u8bdd\u8bf4\u6e05\u695a\uff1a' +
      '\u4e3a\u4ec0\u4e48\u8981\u8d70\u8fd9\u4e00\u6b65\u3001\u5b83\u89e3\u51b3\u4e86\u4ec0\u4e48\u95ee\u9898\uff0c' +
      '\u4ee5\u53ca\u4e3a\u4ec0\u4e48\u4e0d\u9009\u5176\u4ed6\u90a3\u4e9b\u3002' +
      '\u4e0d\u8981\u8d85\u8fc7 100 \u5b57\u3002\u4e0d\u8981\u8f93\u51fa JSON\u3002');
    return [
      { role: 'system', content: SYSTEM_COACH },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  /* 从模型回复里稳妥地抽出 JSON（兼容 ```json 包裹、前后废话等情况） */
  function extractJson(text) {
    if (!text) return null;
    var s = String(text).replace(/```json/gi, '```');
    var fence = s.indexOf('```');
    if (fence >= 0) {
      var end = s.indexOf('```', fence + 3);
      if (end > fence) s = s.slice(fence + 3, end);
    }
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  var api = {
    getConfig: getConfig,
    saveConfig: saveConfig,
    resetConfig: resetConfig,
    isConfigured: isConfigured,
    chat: chat,
    listModels: listModels,
    testConnection: testConnection,
    boardAscii: boardAscii,
    positionBrief: positionBrief,
    coachMessages: coachMessages,
    reviewMessages: reviewMessages,
    explainMoveMessages: explainMoveMessages,
    extractJson: extractJson,
    SYSTEM_COACH: SYSTEM_COACH
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XQAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
