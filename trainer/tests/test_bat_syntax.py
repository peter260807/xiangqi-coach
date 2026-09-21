"""
检查 win/*.bat 的命令格式是否合法。

起因很值得记下来：3-gen-data.bat 里 setlocal 和 enabledelayedexpansion
之间少了一个空格，整行变成一条不存在的命令。后果非常隐蔽 ——

  延迟展开没有启用 -> !ENGINE! 不会被展开 -> 传给 Python 的是字面
  字符串 "!ENGINE!" -> Python 报"找不到引擎" -> 看起来像是路径配错了

实际上变量一切正常，只是那个空格没了。这种错误肉眼几乎看不出来，
必须机器查。

    python tests/test_bat_syntax.py
"""
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# setlocal 只接受这几个选项，写错了要么无效要么整条命令失效
SETLOCAL_OPTS = {
    'enabledelayedexpansion',
    'disabledelayedexpansion',
    'enableextensions',
    'disableextensions',
}

# 成对的感叹号变量引用。用 [A-Za-z_] 而不是 \w，避免出现反斜杠。
BANG_VAR = re.compile(r'![A-Za-z_][A-Za-z0-9_]*!')

# 这些命令后面必须跟空格，粘在一起就是无效命令
NEED_SPACE = ('if', 'for', 'call', 'setlocal')


def check_bat(path):
    raw = open(path, 'rb').read()
    name = os.path.basename(path)
    problems = []

    if not all(b < 128 for b in raw):
        problems.append('含非 ASCII 字节（cmd 会按 GBK 解错）')
    if not raw.startswith(b'@echo off'):
        problems.append('第一行不是 @echo off')
    if b'\r\n' not in raw:
        problems.append('没有 CRLF 行尾')
    if b'\n' in raw.replace(b'\r\n', b''):
        problems.append('存在裸 LF 行尾')
    ctrl = [b for b in raw if b < 32 and b not in (9, 10, 13)]
    if ctrl:
        problems.append('含 %d 个控制字符（多为转义残留）' % len(ctrl))

    text = raw.decode('ascii', errors='replace')
    lines = text.split(chr(13) + chr(10))

    delayed_on = False
    labels = set()
    gotos = set()

    for lineno, line in enumerate(lines, 1):
        s = line.strip()
        if not s:
            continue
        low = s.lower()

        # 收集标签与 goto 目标（注释行也要看标签）
        if s.startswith(':'):
            labels.add(s[1:].split()[0].lower() if len(s) > 1 else '')
        if low.startswith('goto '):
            parts = s.split()
            if len(parts) > 1:
                gotos.add(parts[1].lower())

        if low.startswith('rem') or s.startswith('::'):
            continue

        kind = None
        for cmd in NEED_SPACE:
            if low.startswith(cmd):
                kind = cmd
                break
        if kind:
            rest = s[len(kind):]
            if rest and not rest.startswith(' '):
                problems.append(
                    '第 %d 行：%s 后面少了空格 -> %s' % (lineno, kind, s))
                continue
            if kind == 'setlocal':
                opts = [o.lower() for o in rest.split()]
                for o in opts:
                    if o not in SETLOCAL_OPTS:
                        problems.append(
                            '第 %d 行：setlocal 的选项不认识 -> %s' % (lineno, o))
                if 'enabledelayedexpansion' in opts:
                    delayed_on = True

    # 用了 !变量! 却没开延迟展开 —— 就是这次踩的那个坑
    bangs = []
    for lineno, line in enumerate(lines, 1):
        s = line.strip()
        if s.lower().startswith('rem') or s.startswith('::'):
            continue
        if BANG_VAR.search(s):
            bangs.append(lineno)
    if bangs and not delayed_on:
        problems.append(
            '第 %s 行用了 !变量!，但整个文件没有 setlocal '
            'enabledelayedexpansion —— 这些引用不会展开'
            % ', '.join(str(n) for n in bangs))

    missing = gotos - labels
    if missing:
        problems.append('goto 指向不存在的标签: %s' % ', '.join(sorted(missing)))

    return name, problems


def main():
    files = sorted(glob.glob(os.path.join(ROOT, 'win', '*.bat')))
    if not files:
        print('  [失败] 一个 bat 都没找到，检查 win/ 目录')
        return 1

    bad = 0
    print('=== win/*.bat 命令格式检查 ===')
    for path in files:
        name, problems = check_bat(path)
        if problems:
            bad += 1
            print('  [失败] %s' % name)
            for p in problems:
                print('         - %s' % p)
        else:
            print('  [通过] %s' % name)

    print()
    print('  检查了 %d 个文件' % len(files))
    if bad:
        print('  有 %d 个文件有问题' % bad)
        return 1
    print('  全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
