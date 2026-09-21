"""
核验 win\\*.bat 调用 Python 脚本时传的参数，脚本真的支持。

这看起来是小事，但错了的后果很重：用户双击一下，Python 立刻
"unrecognized arguments" 退出，而那个人可能根本不知道怎么看这个错。

    python tests/test_bat_args.py

没有任何依赖，纯文本比对。
"""
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BACKSLASH = chr(92)


def collect_supported():
    """扫 src/*.py，取出每个脚本 argparse 支持的 -- 选项。"""
    supported = {}
    src = os.path.join(ROOT, 'src')
    for name in sorted(os.listdir(src)):
        if not name.endswith('.py'):
            continue
        args = set()
        path = os.path.join(src, name)
        for line in open(path, encoding='utf-8').read().split(chr(10)):
            s = line.strip()
            if 'add_argument(' not in s:
                continue
            # add_argument('--foo', ...) <- 取第一个引号对里的内容
            for q in ("'", '"'):
                idx = s.find(q)
                if idx >= 0:
                    inner = s[idx + 1:].split(q, 1)[0]
                    if inner.startswith('--'):
                        args.add(inner)
                    break
        if args:
            supported[name] = args
    return supported


def commands_in_bats():
    """产出 (bat 名, 行号, 脚本名, [传给它的 -- 参数])。"""
    for path in sorted(glob.glob(os.path.join(ROOT, 'win', '*.bat'))):
        raw = open(path, 'rb').read().decode('ascii')
        for lineno, line in enumerate(raw.split(chr(13) + chr(10)), 1):
            s = line.strip()
            if not s.startswith('python src'):
                continue
            parts = s.split()
            script = parts[1].replace('/', BACKSLASH).split(BACKSLASH)[-1]
            flags = [p for p in parts[2:] if p.startswith('--')]
            yield os.path.basename(path), lineno, script, flags


def main():
    supported = collect_supported()
    if not supported:
        print('  [失败] 没解析出任何脚本的参数，检查 src/ 目录')
        return 1

    print('=== 脚本支持的参数 ===')
    for k in sorted(supported):
        print('  %-18s %s' % (k, ' '.join(sorted(supported[k]))))
    print()
    print('=== bat 调用的参数核对 ===')

    problems = []
    checked = 0
    for bat, lineno, script, flags in commands_in_bats():
        known = supported.get(script)
        if known is None:
            print('  %-20s 第%2d行 -> %s  [该脚本无 argparse，跳过]'
                  % (bat, lineno, script))
            continue
        unknown = [f for f in flags if f not in known]
        checked += 1
        print('  %-20s 第%2d行 -> %-15s %-58s %s'
              % (bat, lineno, script, ' '.join(flags),
                 'OK' if not unknown else 'FAIL'))
        if unknown:
            print('        !!! 脚本不支持这些参数: %s' % ', '.join(unknown))
            problems.append((bat, lineno, unknown))

    print()
    print('  核对了 %d 条命令' % checked)
    if problems:
        print('  有 %d 处不匹配 —— 用户双击就会失败' % len(problems))
        return 1
    print('  参数全部匹配')
    return 0


if __name__ == '__main__':
    sys.exit(main())
