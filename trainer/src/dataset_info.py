"""
统计一个数据目录的规模与重复率。

    python dataset_info.py --data ../data
    python dataset_info.py --data ../data --limit 4000000    # 快速看一眼

为什么值得单独做成一件事：
**记录数是个几乎没用的数字。** `--opening-plies` 调小的时候，几千万条记录里
可能只有几百万个唯一局面 —— 实测过一次是 3017 万条记录、只有 472 万唯一局面，
重复率 84.3%。按记录数判断"数据够不够"会得出完全相反的结论。

内存上刻意**不把原始记录全读进内存**：上亿条记录是十几 GB，而这个统计只需要
8 字节/条的哈希。所以逐文件、分块地算哈希，最后合并去重 ——
峰值内存约为原始数据的 1/11。
"""

# 控制台编码兜底：Windows 的 cmd 默认是 GBK(936)，遇到它表示不了的字符
# 会抛 UnicodeEncodeError 而中断整个脚本。这里退化成替换而不是崩溃。
import sys as _sys
for _s in (_sys.stdout, _sys.stderr):
    try:
        _s.reconfigure(errors='replace')
    except Exception:
        pass
del _sys, _s
import argparse
import glob
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_data import REC_DTYPE, REC_SIZE, position_hashes   # noqa: E402

# 一次读多少条来算哈希。取大了峰值内存高，取小了循环次数多。
# 100 万条 = 93 MB 原始数据，够平衡。
CHUNK = 1_000_000


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='统计数据集的规模与重复率')
    ap.add_argument('--data', default='../data', help='数据目录')
    ap.add_argument('--limit', type=int, default=0,
                    help='只统计前 N 条（快速看一眼用），0 表示全部')
    return ap.parse_args(argv)


def main():
    args = parse_args()
    files = sorted(glob.glob(os.path.join(args.data, 'part_*.bin')))
    files += [p for p in sorted(glob.glob(os.path.join(args.data, '*.bin')))
              if p not in files]
    if not files:
        print('在 %s 里没找到任何 .bin 数据文件' %args.data)
        return 1

    print('=' * 64)
    print('数据集统计')
    print('  目录: %s' % os.path.abspath(args.data))
    print('=' * 64)

    hashes = []
    total = 0
    # 注意：0 表示"不限"，不能直接拿 0 去比。写成 None 才分得清
    # 「不限」和「额度刚好用完」—— 用 0 的话第一份分片读完就 break 了，
    # 会把 335 万条统计成 44 万条（踩过一次，靠交叉校验才发现）。
    remain = args.limit if args.limit > 0 else None
    t0 = time.time()

    for path in files:
        size = os.path.getsize(path)
        n = size // REC_SIZE
        if remain is not None:
            n = min(n, remain)
        read = 0
        with open(path, 'rb') as f:
            while read < n:
                k = min(CHUNK, n - read)
                a = np.fromfile(f, dtype=REC_DTYPE, count=k)
                if len(a) == 0:
                    break
                hashes.append(position_hashes(a))
                read += len(a)
        total += read
        if remain is not None:
            remain -= read
        print('  %-20s %12d 条   %8.1f MB'
              % (os.path.basename(path), read, size / 1024 / 1024))
        if remain is not None and remain <= 0:
            break

    print()
    if total == 0:
        print('  这是空数据集，先跑 gen_data.py。')
        return 1

    print('  记录总数 : %d' % total)
    print('  正在统计唯一局面（要排序，数据多时这一步最慢）…')
    h = np.concatenate(hashes) if len(hashes) > 1 else hashes[0]
    del hashes
    uniq = int(len(np.unique(h)))
    del h

    dup = 100.0 * (1 - uniq / total)
    print('  唯一局面 : %d' % uniq)
    print('  重复率   : %.1f%%' % dup)
    print('  平均每个局面出现 %.2f 次' % (total / max(uniq, 1)))
    print('  占用     : %.2f GB' % (total * REC_SIZE / 1024 ** 3))
    print('  用时     : %.1f 秒' % (time.time() - t0))
    print()
    if total < uniq:
        print('  [注意] 唯一局面比记录数还多，说明统计出了问题。')
        return 1
    if dup > 40:
        print('  [注意] 重复率偏高。记录数被重复局面撑大了 ——')
        print('         调大 --opening-plies 比延长生成时间更有效。')
    else:
        print('  重复率在健康范围内（实测 --opening-plies 14 大约是 33%）。')
    print('=' * 64)
    return 0


if __name__ == '__main__':
    sys.exit(main())
