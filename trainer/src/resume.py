"""
断点续跑用的公共小工具：原子写文件、分片扫描与修补、数据指纹。

单独成模块的理由：数据生成（gen_data）和训练（train）都要用，而且
「原子写」这件事在两边必须一致 —— 正卡在写盘时断电，宁可丢一次进度，
也不能留下一个半损坏的文件让下次 resume 读到错的东西。
"""
import glob
import hashlib
import json
import os
import time

PROGRESS_NAME = '_progress.json'


def read_json(path):
    """读 JSON；文件不存在或读坏了一律当作「没有进度」。

    坏文件不抛异常是刻意的：一个坏 JSON 不该让整晚的任务停在那里等人处理，
    后续流程会重新生成/重新训练，代价可控。
    """
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def write_json_atomic(path, data):
    """先写 .tmp 再 replace：replace 在同一文件系统上是原子的。

    直接覆写原文件的话，写到一半掉电就会留下一个被截断的 JSON，
    下次 resume 读到的进度是错的（而且是安静地错）。
    """
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---- 数据生成的进度 ----

def read_progress(out_dir):
    return read_json(os.path.join(out_dir, PROGRESS_NAME))


def update_progress(out_dir, **kw):
    """合并式更新，避免并发/多次写入互相覆盖。"""
    path = os.path.join(out_dir, PROGRESS_NAME)
    old = read_json(path)
    old.update(kw)
    old['updated'] = time.strftime('%Y-%m-%d %H:%M:%S')
    write_json_atomic(path, old)
    return old


def scan_shards(out_dir, rec_size):
    """返回 [(路径, 记录数)]，按文件名排序。

    记录数用「文件大小 // 单条字节数」算，所以崩在半路留下的半条记录会被忽略 ——
    统计不会因此虚高。
    """
    out = []
    for p in sorted(glob.glob(os.path.join(out_dir, 'part_*.bin'))):
        out.append((p, os.path.getsize(p) // rec_size))
    return out


def trim_partial_tail(path, rec_size):
    """把崩在半路留下的半条记录截掉，返回截掉的字节数。

    **这一步不能省。** 分片是 append 模式，如果尾部留着半条记录，
    下次 append 会从半条记录之后接着写，于是**整个文件从那里开始错位** ——
    每条记录的边界都偏了，训练时读到的是错位的棋盘和分值，而且不会报错。
    """
    if not os.path.isfile(path):
        return 0
    size = os.path.getsize(path)
    rest = size % rec_size
    if rest == 0:
        return 0
    with open(path, 'r+b') as f:
        f.truncate(size - rest)
    return rest


def data_fingerprint(data_dir, rec_size):
    """数据集指纹：分片数 + 总记录数 + 基于文件名与各片条数的摘要。

    训练 resume 时用它确认「数据没被换过」。注意它**不读文件内容** ——
    几个 GB 全读一遍要几十秒，而常见的变动（多跑了一轮数据生成、换了目录）
    只靠文件名和条数就能查出来。真要防篡改得再算内容哈希，这里不需要。
    """
    parts = scan_shards(data_dir, rec_size)
    h = hashlib.sha256()
    total = 0
    for p, n in parts:
        h.update(os.path.basename(p).encode())
        h.update(str(n).encode())
        total += n
    return {'files': len(parts), 'records': total, 'digest': h.hexdigest()[:16]}
