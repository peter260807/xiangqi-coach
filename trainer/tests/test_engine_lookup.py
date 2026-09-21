"""
验证引擎查找逻辑在各种放置方式下都能正确工作。

为什么要测这个：用户放引擎的方式五花八门 —— 保留下载时的原名、
解压多套一层目录、忘了放权重。这些情况如果在代码里没覆盖，表现
都是同一句"找不到引擎"，用户根本无从下手。

（起因：run-all.bat / 3-gen-data.bat 曾经在 cmd 里做路径查找，
一个空格写错就整个失效，而且报的错还是"找不到引擎"，误导性极强。
现在查找逻辑统一在 Python 里，这里就是给它上的保险。）

    python tests/test_engine_lookup.py
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))

import gen_data                                                # noqa: E402

# 每个场景：(说明, 要放的文件列表, 期望找到引擎, 期望找到权重)
SCENARIOS = [
    ('改成标准名 pikafish.exe',
     ['pikafish.exe', 'pikafish.nnue'], True, True),

    ('保留下载时的原名（官网就是这个长名字）',
     ['Pikafish-Windows-x86-64-universal.exe', 'pikafish.nnue'], True, True),

    ('解压时多套了一层目录',
     ['Pikafish.2026-09-06/pikafish.exe',
      'Pikafish.2026-09-06/pikafish.nnue'], True, True),

    ('exe 放了但忘了放权重',
     ['pikafish.exe'], True, False),

    ('目录是空的',
     [], False, False),

    ('只放了权重没放 exe',
     ['pikafish.nnue'], False, False),
]


def run_scenario(files):
    """在临时目录里造出场景，返回 (引擎路径, 权重路径)。"""
    tmp = tempfile.mkdtemp(prefix='xq-engine-test-')
    original = gen_data.ENGINE_DIR
    try:
        gen_data.ENGINE_DIR = tmp
        for rel in files:
            full = os.path.join(tmp, rel.replace('/', os.sep))
            parent = os.path.dirname(full)
            if parent:
                os.makedirs(parent, exist_ok=True)
            open(full, 'wb').write(b'x' * 512)

        eng = gen_data.find_engine()
        nnue = gen_data.find_nnue(eng) if eng else None
        return (os.path.basename(eng) if eng else None,
                os.path.basename(nnue) if nnue else None)
    finally:
        gen_data.ENGINE_DIR = original
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ok = True
    print('=== 引擎查找场景验证 ===')
    for title, files, want_eng, want_nnue in SCENARIOS:
        eng, nnue = run_scenario(files)
        pass_eng = (eng is not None) == want_eng
        pass_nnue = (nnue is not None) == want_nnue
        good = pass_eng and pass_nnue
        ok = ok and good
        print()
        print('  %s  %s' % ('[通过]' if good else '[失败]', title))
        print('     放了     : %s' % (files or '（什么都没放）'))
        print('     找到引擎 : %s' % (eng or '无'))
        print('     找到权重 : %s' % (nnue or '无'))
        if not good:
            print('     期望引擎 %s / 期望权重 %s'
                  % ('有' if want_eng else '无', '有' if want_nnue else '无'))

    print()
    print('  验证了 %d 个场景' % len(SCENARIOS))
    if ok:
        print('  全部符合预期')
        return 0
    print('  有场景不符合预期')
    return 1


if __name__ == '__main__':
    sys.exit(main())
