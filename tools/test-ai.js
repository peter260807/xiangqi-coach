/* 大模型客户端联通性测试（会真实调用接口，耗时约 30~90 秒） */
require('../web/js/engine.js');
require('../web/js/config.js');
var XQ = require('../web/js/engine.js');
var AI = require('../web/js/ai.js');

function line(s) { console.log(s); }

(async function () {
  var cfg = AI.getConfig();
  line('接口地址: ' + cfg.baseUrl);
  line('模型: ' + cfg.model + '    maxTokens: ' + cfg.maxTokens);
  line('');

  line('=== 1. 模型列表 ===');
  try {
    var models = await AI.listModels();
    line('可用模型: ' + models.join(', '));
  } catch (e) { line('失败: ' + e.message); }

  line('');
  line('=== 2. 连接测试（流式，观察思维链/正文分离） ===');
  var t0 = Date.now();
  var reasoningSeen = 0, contentSeen = 0;
  try {
    var r = await AI.chat(
      [{ role: 'user', content: '只回复两个字：正常' }],
      {
        maxTokens: 1500, temperature: 0,
        onReasoning: function (d) { reasoningSeen += d.length; },
        onDelta: function (d) { contentSeen += d.length; }
      }
    );
    line('耗时 ' + (Date.now() - t0) + 'ms');
    line('思维链流式片段总长 ' + reasoningSeen + ' 字符，正文流式片段总长 ' + contentSeen + ' 字符');
    line('正文: ' + JSON.stringify((r.content || '').trim()));
    if (r.usage) line('用量: 输入 ' + r.usage.prompt_tokens + ' / 输出 ' + r.usage.completion_tokens +
      (r.usage.completion_tokens_details ? '（其中思维链 ' + r.usage.completion_tokens_details.reasoning_tokens + '）' : ''));
  } catch (e) { line('失败: ' + e.message); }

  line('');
  line('=== 3. 教练点评（真实局面 + 引擎候选） ===');
  var board = XQ.parseBoard(XQ.START);
  XQ.makeMove(board, XQ.findMoveByLabel(board, 'r', '炮二平五'));
  XQ.makeMove(board, XQ.findMoveByLabel(board, 'b', '马8进7'));
  XQ.makeMove(board, XQ.findMoveByLabel(board, 'r', '马二进三'));
  var cands = XQ.topMoves(board, 'r', 4, 4, 2000);
  var score = XQ.evaluate(board);
  line('候选着法: ' + cands.map(function (c) { return c.label + '(' + c.score + ')'; }).join('  '));
  t0 = Date.now();
  try {
    var coach = await AI.chat(AI.coachMessages({
      board: board, side: 'r',
      moveText: '1. 炮二平五 马8进7  2. 马二进三',
      engineScore: score, candidates: cands
    }), { maxTokens: 3200 });
    line('耗时 ' + (Date.now() - t0) + 'ms');
    line('--- 点评 ---');
    line((coach.content || '').trim());
  } catch (e) { line('失败: ' + e.message); }

  line('');
  line('=== 4. 混合对弈选着（模型从候选里挑，必须能解析出合法着法） ===');
  t0 = Date.now();
  try {
    var pick = await AI.chat(AI.pickMoveMessages({ board: board, side: 'r', candidates: cands }), { maxTokens: 2500, temperature: 0.3 });
    line('耗时 ' + (Date.now() - t0) + 'ms');
    line('原始回复: ' + JSON.stringify((pick.content || '').trim().slice(0, 200)));
    var obj = AI.extractJson(pick.content);
    if (!obj) { line('结果: 未能解析出 JSON'); }
    else {
      var mv = XQ.findMoveByLabel(board, 'r', obj.move);
      line('模型选择: ' + obj.move + '   理由: ' + (obj.reason || ''));
      line('合法性校验: ' + (mv ? '通过，解析为着法 ' + XQ.moveLabel(board, mv) : '失败——将回退到引擎推荐着法'));
      var candLabels = cands.map(function (c) { return c.label; });
      line('是否在候选列表内: ' + (candLabels.indexOf(obj.move) >= 0 ? '是' : '否'));
    }
  } catch (e) { line('失败: ' + e.message); }

  line('');
  line('=== 5. 复盘报告 ===');
  var seq = ['炮二平五', '马8进7', '马二进三', '车9平8', '车一平二', '马2进3', '兵三进一', '卒3进1'];
  var b2 = XQ.parseBoard(XQ.START), side = 'r', text = [];
  seq.forEach(function (t, i) {
    var m = XQ.findMoveByLabel(b2, side, t);
    if (!m) return;
    text.push((i % 2 === 0 ? ((i / 2 | 0) + 1) + '. ' : '') + t);
    XQ.makeMove(b2, m); side = XQ.other(side);
  });
  t0 = Date.now();
  try {
    var rev = await AI.chat(AI.reviewMessages({
      moveText: text.join('  '),
      result: '进行到第 4 回合，未分胜负',
      endBoard: b2,
      evalTrace: []
    }), { maxTokens: 3200 });
    line('耗时 ' + (Date.now() - t0) + 'ms');
    line('--- 复盘 ---');
    line((rev.content || '').trim());
  } catch (e) { line('失败: ' + e.message); }

  line('');
  line('=== 全部测试结束 ===');
})();
