#!/usr/bin/env python3
"""断点恢复的测试。

这套逻辑值得单独测的原因：它出错的**表现都很安静** ——
分片错位了照样能读、进度记错了照样能跑、续训接错轮次照样收敛，
只是结果全都不对，而且要到几个小时后才可能被发现。

    python tests/test_resume.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'src'))

import resume                                    # noqa: E402
import pipeline                                  # noqa: E402
from gen_data import REC_DTYPE, REC_SIZE, elapsed_seconds   # noqa: E402

FAILED = []


def check(name, cond, detail=''):
    print('  %s %-56s %s' % ('[通过]' if cond else '[失败]', name,
                             detail if not cond else ''))
    if not cond:
        FAILED.append(name)


def make_shard(path, n, seed=0):
    """写一个分片：n 条随机记录（棋盘随机摆几个子，保证局面互不相同）。"""
    rng = np.random.default_rng(seed)
    a = np.zeros(n, dtype=REC_DTYPE)
    chars = np.frombuffer(b'KABNRCPkabnrcp', dtype=np.uint8)
    for i in range(n):
        board = bytearray(b'.' * 90)
        for _ in range(int(rng.integers(6, 13))):
            board[int(rng.integers(0, 90))] = chars[int(rng.integers(0, 14))]
        a['board'][i] = bytes(board)
        a['cp'][i] = int(rng.integers(-500, 500))
        a['side'][i] = int(rng.integers(0, 2))
    a.tofile(path)
    return n


# ---------------- 1. 原子写与坏文件兜底 ----------------

def test_atomic_write(tmp):
    # 注意要用 resume.PROGRESS_NAME 这个名字：update_progress/read_progress 认的是它，
    # 换个名字去写就会变成"写在一个文件、读另一个文件"（第一版测试就踩了这个）
    p = os.path.join(tmp, resume.PROGRESS_NAME)
    resume.write_json_atomic(p, {'a': 1})
    check('原子写之后能读回来', resume.read_json(p) == {'a': 1})
    check('不留下 .tmp 残留', not os.path.exists(p + '.tmp'))

    # 模拟写入过程中被截断：直接写坏文件，读的时候必须当成"没有进度"
    with open(p, 'w') as f:
        f.write('{"a": 1, "b"')
    check('坏 JSON 视为没有进度（不抛异常）', resume.read_json(p) == {})
    check('文件不存在也返回空', resume.read_json(os.path.join(tmp, 'nope.json')) == {})

    # 合并式更新不能丢掉已有字段
    resume.write_json_atomic(p, {'a': 1})
    resume.update_progress(tmp, b=2)
    prog = resume.read_progress(tmp)
    check('合并更新保留已有字段', prog.get('a') == 1 and prog.get('b') == 2,
          str(prog))


# ---------------- 2. 分片扫描与半条记录修补 ----------------

def test_trim_and_scan(tmp):
    d = os.path.join(tmp, 'shards')
    os.makedirs(d)
    make_shard(os.path.join(d, 'part_00.bin'), 100)
    make_shard(os.path.join(d, 'part_01.bin'), 250)

    shards = resume.scan_shards(d, REC_SIZE)
    check('分片按名字排序', [os.path.basename(p) for p, _ in shards]
          == ['part_00.bin', 'part_01.bin'])
    check('记录数统计正确', [n for _, n in shards] == [100, 250], str(shards))

    # 崩在半路：尾部多出半条记录
    p0 = os.path.join(d, 'part_00.bin')
    with open(p0, 'ab') as f:
        f.write(b'\x01' * 37)
    size_before = os.path.getsize(p0)
    check('半条记录不会让统计虚高',
          resume.scan_shards(d, REC_SIZE)[0][1] == 100)

    cut = resume.trim_partial_tail(p0, REC_SIZE)
    check('修补返回被截掉的字节数', cut == 37, str(cut))
    check('修补后大小是整记录数倍',
          os.path.getsize(p0) == size_before - 37
          and os.path.getsize(p0) % REC_SIZE == 0)
    check('修补是幂等的（再调不变）',
          resume.trim_partial_tail(p0, REC_SIZE) == 0)
    check('文件不存在时返回 0 而非报错',
          resume.trim_partial_tail(os.path.join(d, 'nope.bin'), REC_SIZE) == 0)

    # 错位检测：修补之后追加的记录必须仍然对齐（合法字符集）
    with open(p0, 'ab') as f:
        make_shard(os.path.join(tmp, 'tail.bin'), 50, seed=9)
        f.write(open(os.path.join(tmp, 'tail.bin'), 'rb').read())
    raw = np.fromfile(p0, dtype=np.uint8).reshape(-1, REC_SIZE)
    allowed = np.frombuffer(b'.KABNRCPkabnrcp', dtype=np.uint8)
    bad = (~np.isin(raw[:, :90], allowed)).any(axis=1).sum()
    check('修补后追加的数据仍然对齐', bad == 0, '非法字符记录 %d 条' % bad)


# ---------------- 3. 时长记账与估算兜底 ----------------

def test_elapsed(tmp):
    d = os.path.join(tmp, 'gen')
    os.makedirs(d)
    # 空目录
    sec, est = elapsed_seconds(d, 1500)
    check('空目录：0 秒且不算估算', sec == 0 and not est)

    # 有数据但没有进度文件（旧版本生成的）→ 按速率估算
    make_shard(os.path.join(d, 'part_00.bin'), 3000)
    sec, est = elapsed_seconds(d, 1500)
    check('旧数据按速率估算', abs(sec - 2.0) < 1e-6 and est, '%.3f' % sec)

    # 有进度文件时以文件为准
    resume.update_progress(d, elapsed_sec=600)
    sec, est = elapsed_seconds(d, 1500)
    check('有进度文件时用真实值', sec == 600 and not est, str(sec))


# ---------------- 4. 数据指纹 ----------------

def test_fingerprint(tmp):
    d = os.path.join(tmp, 'fp')
    os.makedirs(d)
    make_shard(os.path.join(d, 'part_00.bin'), 100)
    f1 = resume.data_fingerprint(d, REC_SIZE)
    check('指纹含分片数与总条数',
          f1['files'] == 1 and f1['records'] == 100, str(f1))

    make_shard(os.path.join(d, 'part_01.bin'), 50)
    f2 = resume.data_fingerprint(d, REC_SIZE)
    check('新增分片后指纹变化', f2['digest'] != f1['digest'])

    # 同一个分片变大（接着 append）
    with open(os.path.join(d, 'part_00.bin'), 'ab') as f:
        make_shard(os.path.join(tmp, 'more.bin'), 10, seed=3)
        f.write(open(os.path.join(tmp, 'more.bin'), 'rb').read())
    f3 = resume.data_fingerprint(d, REC_SIZE)
    check('分片变大后指纹变化', f3['digest'] != f2['digest'])


# ---------------- 5. pipeline 的「做完了吗」判断 ----------------

def test_pipeline_checks(tmp):
    d = os.path.join(tmp, 'pipe')
    os.makedirs(d)
    old = pipeline.CONFIG['data_dir']
    pipeline.CONFIG['data_dir'] = d
    try:
        done, detail = pipeline.gen_done()
        check('无分片 → 未完成', not done, detail)

        make_shard(os.path.join(d, 'part_00.bin'), 3000)
        done, detail = pipeline.gen_done()
        check('有分片但时长未达标 → 未完成', not done, detail)

        # 按目标时长把进度写满
        target_min = pipeline.CONFIG['minutes']
        resume.update_progress(d, elapsed_sec=target_min * 60, minutes_target=target_min)
        done, detail = pipeline.gen_done()
        check('累计时长达标 → 已完成', done, detail)
    finally:
        pipeline.CONFIG['data_dir'] = old


# ---------------- 6. 端到端：真跑一次训练续训 ----------------

def test_train_resume_end_to_end(tmp):
    data = os.path.join(tmp, 'data')
    out = os.path.join(tmp, 'logs')
    os.makedirs(data)
    make_shard(os.path.join(data, 'part_00.bin'), 6000, seed=11)
    make_shard(os.path.join(data, 'part_01.bin'), 6000, seed=12)
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')

    def run_train(extra):
        return subprocess.run(
            [sys.executable, os.path.join(ROOT, 'src', 'train.py'),
             '--data', data, '--out', out, '--batch', '1024',
             '--l1', '16', '--l2', '8', '--log-every', '5'] + extra,
            cwd=ROOT, env=env, capture_output=True, text=True)

    r1 = run_train(['--epochs', '1'])
    log = open(os.path.join(out, 'train.log'), encoding='utf-8').read()
    check('第一次训练跑完第 1 轮', r1.returncode == 0 and '轮次 1 完成' in log,
          r1.stderr[-300:])
    check('checkpoint 已生成', os.path.isfile(os.path.join(out, 'ckpt.pt')))

    r2 = run_train(['--epochs', '2'])
    log = open(os.path.join(out, 'train.log'), encoding='utf-8').read()
    check('第二次运行从第 2 轮继续（不是从第 1 轮重来）',
          '从断点继续：已完成 1 轮，从第 2 轮开始' in log, r2.stdout[-300:])
    check('续训后跑完第 2 轮', '轮次 2 完成' in log)
    check('续训后 checkpoint 的轮次是 2',
          _ckpt_epoch(os.path.join(out, 'ckpt.pt')) == 2)

    r3 = run_train(['--epochs', '3', '--l1', '32'])
    check('形状参数不一致时拒绝续训（退出码 2）', r3.returncode == 2,
          '实际 %d' % r3.returncode)
    check('拒绝时给出明确提示', '拒绝续训' in r3.stdout)

    r4 = run_train(['--epochs', '1', '--fresh'])
    check('--fresh 从头训练（回到第 1 轮）', r4.returncode == 0
          and '--fresh：已丢弃旧 checkpoint' in r4.stdout)
    check('--fresh 后 checkpoint 轮次是 1',
          _ckpt_epoch(os.path.join(out, 'ckpt.pt')) == 1)


def _ckpt_epoch(path):
    import torch
    return int(torch.load(path, map_location='cpu', weights_only=False)['epoch'])


def main():
    print('=' * 68)
    print('断点恢复测试')
    print('=' * 68)
    tmp = tempfile.mkdtemp(prefix='xq-resume-')
    try:
        test_atomic_write(tmp)
        print()
        test_trim_and_scan(tmp)
        print()
        test_elapsed(tmp)
        print()
        test_fingerprint(tmp)
        print()
        test_pipeline_checks(tmp)
        print()
        test_train_resume_end_to_end(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print('=' * 68)
    if FAILED:
        print('失败 %d 项：%s' % (len(FAILED), '、'.join(FAILED)))
        return 1
    print('全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
