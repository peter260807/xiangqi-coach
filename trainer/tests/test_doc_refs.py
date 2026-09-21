"""
核对代码与文档里提到的文件名是否真实存在。

为什么值得单独测：用户拿到的是文档，照着双击。文档里写错一个文件名，
用户就会对着"系统找不到指定的文件"发呆，而且他没法判断是文档错了
还是自己操作错了。我自己就写错过一次 —— 自检脚本最后打印的流程里，
编号和实际文件对不上。

    python tests/test_doc_refs.py

只做纯文本比对，没有依赖。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 正则里刻意不出现反斜杠：工具链传参会把反斜杠吃掉或异变。
# 用 [.] 代替 \.，用字符类代替 \w。
#
# 末尾的边界断言不能省。没有它，下面两类东西会被误判成文件名：
#   文档里出现的网站域名 —— 域名中间那一段正好长得像文件名
#   命令行参数名 —— 参数名的前缀正好长得像文件名
# 要求后面不是字母数字，这两类就都排除了。
# （注释里刻意不写出具体例子，否则本文件会自己匹配到自己。）
TOKEN = re.compile(r'[0-9A-Za-z_-]+[.](?:bat|py)(?![A-Za-z0-9])')


def known_names():
    names = set()
    for sub in ('win', 'src', 'tests'):
        d = os.path.join(ROOT, sub)
        if os.path.isdir(d):
            names |= set(os.listdir(d))
    return names


def files_to_scan():
    out = [os.path.join(ROOT, 'README.md')]
    for sub in ('src', 'tests'):
        d = os.path.join(ROOT, sub)
        if os.path.isdir(d):
            out += [os.path.join(d, n) for n in sorted(os.listdir(d))
                    if n.endswith('.py')]
    win = os.path.join(ROOT, 'win')
    if os.path.isdir(win):
        out += [os.path.join(win, n) for n in sorted(os.listdir(win))
                if n.endswith('.bat')]
    return [p for p in out if os.path.isfile(p)]


def main():
    known = known_names()
    problems = []
    checked = 0

    print('=== 扫描代码与文档中的文件名引用 ===')
    for path in files_to_scan():
        rel = os.path.relpath(path, ROOT)
        try:
            text = open(path, encoding='utf-8', errors='replace').read()
        except Exception as exc:
            print('  [警告] %s 读不了：%s' % (rel, exc))
            continue
        for lineno, line in enumerate(text.split(chr(10)), 1):
            for tok in TOKEN.findall(line):
                checked += 1
                if tok in known:
                    continue
                problems.append((rel, lineno, tok))
                print('  [失败] %s:%d 提到了不存在的 %s' % (rel, lineno, tok))

    print()
    print('  共检查 %d 处文件名引用' % checked)
    if checked < 20:
        # 防止"一处都没匹配到"被读成"全部通过"
        print('  [失败] 只检查到 %d 处 —— 太少了，扫描逻辑可能已失效' % checked)
        return 1
    if problems:
        print('  有 %d 处引用了不存在的文件' % len(problems))
        return 1
    print('  引用的文件全部存在')
    return 0


if __name__ == '__main__':
    sys.exit(main())
