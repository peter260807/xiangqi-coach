#!/usr/bin/env python3
"""给 engine.js 打一个「可替换评估函数」的补丁，产出独立的副本。

刻意用逐字替换（不用正则、不用 sed）：正则里的反斜杠经工具参数传递时会被吃掉，
而检查脚本还会照报"通过" —— 这类静默失败比不检查更危险。

补丁只改三处：
  1. 两处 `sign * evaluate(b)` -> 走可替换的 __evalFn（带回 side 参数）
  2. `evaluate: evaluate,` 后面挂一个 setEval 到对外 API
  3. 在 api 对象前声明 __evalFn（var 会提升，闭包内的调用能看到）
"""
import os
import shutil

SRC = '/Users/GoodHarvest/WorkBuddy/2026-09-21-00-07-27/xiangqi-coach/web/js/engine.js'
DST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'engine.js')

s = open(SRC, encoding='utf-8').read()
orig = s

REPLACEMENTS = [
    ('sign * evaluate(b)',
     'sign * (__evalFn ? __evalFn(b, side) : evaluate(b))'),
    ('    evaluate: evaluate,',
     '    evaluate: evaluate, setEval: function (f) { __evalFn = f; },'),
    ('  var api = {',
     '  var __evalFn = null;\n  var api = {'),
]

print('打补丁：%s' % SRC)
for old, new in REPLACEMENTS:
    n = s.count(old)
    assert n > 0, '没找到待替换的片段：%r —— 逐字替换失败，必须停下来查' % old
    s = s.replace(old, new)
    print('  %-38s 替换 %d 处' % (old.strip()[:38], n))

assert s != orig
open(DST, 'w', encoding='utf-8').write(s)
print('  写出 %s（%d 字节）' % (DST, os.path.getsize(DST)))

# 自证：补丁后该文件里必须能看到新的调用形式与 setEval
for probe in ('__evalFn ? __evalFn(b, side)', 'setEval: function', 'var __evalFn = null;'):
    c = s.count(probe)
    assert c > 0, '补丁后找不到 %r' % probe
    print('  核验 %-32s 出现 %d 次' % (probe, c))
