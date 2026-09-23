"""
自证：pipeline 的「缺依赖导致没产出」必须被看见，不能混进「成功」。

背景（一次真实事故）：Windows 上把整条流程跑完，界面一路打印成功，打包回传后
才发现 `results/05-handcrafted.txt` 不存在 —— 而它是「只看两个数」里的一个
（平均丢分那张表）。根因是 `stage_handcrafted` 找不到 node 时直接 `return 0`，
上层把它当成了「这一步完成了」。

本测试就盯这一件事，四个层面都断言：

  1. `stage_handcrafted` 缺 node 时返回 `SKIPPED`（而不是 0）
  2. `cmd_run` 遇到 `SKIPPED` 时**不打印「完成于」**、**退出码非 0**
  3. 完成判断不能把「空文件」「跑到一半的文件」算成完成
  4. 产物清单能把缺的那几项点名点出来

需要 numpy（pipeline 会 import gen_data），所以用项目自己的 Python 跑：

    python tests/test_pipeline_skip.py      # 退出码 0 = 全部通过
"""
import contextlib
import io
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'src'))

import pipeline  # noqa: E402

FAILS = []
CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if cond:
        print('  [通过] %s' % msg)
    else:
        print('  [失败] %s' % msg)
        FAILS.append(msg)


def capture(fn, *a, **kw):
    """跑 fn 并把它打印的东西一起收回来（只看输出、不落到终端上刷屏）。"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(*a, **kw)
    return rc, buf.getvalue()


def main():
    check(pipeline.SKIPPED == -1 and pipeline.SKIPPED != 0,
          'SKIPPED 既不是 0（成功）也不是正数（失败），是第三个状态')

    # 整条测试都在一个临时根目录里跑，不碰真实的 results/
    real_root = pipeline.ROOT
    real_which = pipeline.shutil.which
    tmp = tempfile.mkdtemp(prefix='xq-pipeline-test-')
    try:
        pipeline.ROOT = tmp

        # ---- 1. 缺 node ----
        print()
        print('=== 1. 没有 node.js 的时候 ===')
        os.makedirs(os.path.join(tmp, 'results'), exist_ok=True)
        with open(os.path.join(tmp, 'results', 'positions.json'), 'w') as f:
            f.write('[]')                      # 只要存在就行，本测试不真跑 node

        pipeline.shutil.which = lambda name: None if name == 'node' else real_which(name)
        args = type('A', (), {'fresh': False})()
        rc, out = capture(pipeline.stage_handcrafted, args)
        check(rc == pipeline.SKIPPED,
              '缺 node 时 stage_handcrafted 返回 SKIPPED（实测 %r）——不是 0' % (rc,))
        check('未产出' in out, '输出里明确说了「未产出」')
        check('05-handcrafted.txt' in out, '输出里点名了缺席的那份产物')

        # ---- 2. 连输入都没有的时候 ----
        print()
        print('=== 2. 连上一步的 positions.json 都没有 ===')
        os.remove(os.path.join(tmp, 'results', 'positions.json'))
        rc, out = capture(pipeline.stage_handcrafted, args)
        check(rc == pipeline.SKIPPED, '缺输入时同样返回 SKIPPED')
        check('positions.json' in out, '输出里指出了缺的是哪份输入')

        # ---- 3. 完成判断：空文件 / 半截文件 ----
        print()
        print('=== 3. 完成判断不能被骗 ===')
        rd = os.path.join(tmp, 'results')
        rel = '05-handcrafted.txt'
        check(pipeline._file_done(rel, '对照报告', must_contain='名次已写入')[0] is False,
              '文件不存在 -> 未完成')
        open(os.path.join(rd, rel), 'w').close()
        check(pipeline._file_done(rel, '对照报告', must_contain='名次已写入')[0] is False,
              '空文件（命令刚启动就崩）-> 未完成')
        with open(os.path.join(rd, rel), 'w') as f:
            f.write('局面数 484\n  平均丢分 …\n')      # 跑到一半被杀
        check(pipeline._file_done(rel, '对照报告', must_contain='名次已写入')[0] is False,
              '有内容但没有收尾标记 -> 未完成')
        with open(os.path.join(rd, rel), 'a') as f:
            f.write('  名次已写入 results/ranks.json\n')
        check(pipeline._file_done(rel, '对照报告', must_contain='名次已写入')[0] is True,
              '内容完整且带收尾标记 -> 完成')

        # ---- 4. 整个 run 的收尾状态 ----
        print()
        print('=== 4. 跑一次 run craft（没有 node）看退出码 ===')
        # 关键：先把上一步造出来的那份「完整」报告删掉，否则 craft 会被当成
        # 已完成而直接跳过，就测不到「未产出」这条路径了。
        os.remove(os.path.join(rd, rel))
        rc, out = capture(pipeline.main, ['run', 'craft'])
        check(rc == 3, '退出码是 3（非 0），自动化能发现这次运行不完整（实测 %r）' % (rc,))
        check('不算成功' in out, '收尾明确写了「这次运行不算成功」')
        check('未产出' in out, '把「没有产出的步骤」列了出来')
        check('完成于' not in out,
              '**没有再打印「完成于」** —— 这正是原来那个谎报成功的地方')
        check('全部完成' not in out, '**没有打印「全部完成」**（原来会的）')

        # ---- 5. 产物清单 ----
        print()
        print('=== 5. 产物清单点名 ===')
        missing, present = pipeline.artifact_manifest()
        names = [n for n, _ in missing]
        check('05-handcrafted.txt' in names, '清单里点了 05-handcrafted.txt 的名')
        check(len(missing) + len(present) == len(pipeline.ARTIFACT_MANIFEST),
              '清单项数对得上（%d 项）' % len(pipeline.ARTIFACT_MANIFEST))

        # 把清单填满，确认能变成「齐」
        for name, _ in pipeline.ARTIFACT_MANIFEST:
            with open(os.path.join(rd, name), 'w') as f:
                f.write('x\n')
        missing2, _ = pipeline.artifact_manifest()
        check(missing2 == [], '全部补齐后清单不再报缺')

    finally:
        pipeline.ROOT = real_root
        pipeline.shutil.which = real_which
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print('=' * 60)
    if FAILS:
        print('失败 %d / %d 项：' % (len(FAILS), CHECKS))
        for m in FAILS:
            print('  · %s' % m)
        return 1
    print('全部通过（%d 项断言）' % CHECKS)
    return 0


if __name__ == '__main__':
    sys.exit(main())
