"""
一键全流程（带断点恢复）。

为什么把编排放 Python 而不是 bat：

1. bat 里写不了「这一步做完了没有」的判断，只能用 `if exist` 猜。原来有一段
   更糟：只要 data 目录存在就 `rd /s /q` 删掉重来 —— 实测一次 Windows 自动
   更新重启（半夜跑着 540 分钟的数据生成），重启后 **9 小时的数据被删了**。
2. bat 有编码限制（纯 ASCII + CRLF + 无 BOM），中文注释随时可能写坏。
3. 放这里之后，整套跳过逻辑在 macOS / Linux 上也能直接跑测试。

用法：

    python src/pipeline.py status          # 只看每一步做完没有，不跑东西
    python src/pipeline.py run             # 跑（已完成的步骤自动跳过）
    python src/pipeline.py run --fresh     # 忽略断点，全部重跑
    python src/pipeline.py run gen train   # 只跑指定步骤

参数改下面 CONFIG 这一块即可（不再需要去改 bat）。
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resume                                # noqa: E402
from gen_data import REC_SIZE, elapsed_seconds   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------- 参数（想调就改这里） ----------------

CONFIG = {
    # 数据生成
    'data_dir': 'data/v2',
    'workers': 14,          # 按 CPU 核数设：8 核 16 线程的机器给 14 比较合适
    'depth': 8,
    'opening_plies': 14,    # 开局随机步数，太小会让重复率飙升
    'minutes': 540,         # 累计生成时长，跨重启累计，不是每次从头算
    'rate_hint': 1500,      # 只用于「这批数据没有时长记录」时反推已跑多久

    # 训练
    'logs_dir': 'logs/v2',
    'epochs': 8,
    'batch': 8192,
    'lr': 0.001,
    'l1': 512,
    'l2': 64,

    # 评估
    'eval_positions': 500,
    'eval_multipv': 8,
    'eval_depth': 10,

    # 产出
    'results_dir': 'results',
    'net_name': 'xq-v2.xqnn',
}


def path(key):
    return os.path.join(ROOT, CONFIG[key].replace('/', os.sep))


def data_dir():
    return path('data_dir')


def logs_dir():
    return path('logs_dir')


def results_dir():
    return path('results_dir')


def net_path():
    return os.path.join(logs_dir(), CONFIG['net_name'])


# ---------------- 跑一条命令 ----------------

def run(cmd, log_file=None, env_extra=None):
    """跑一条命令。log_file 不为空时把输出重定向进去，跑完再打印出来。"""
    print('  $ %s' % ' '.join(cmd), flush=True)
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    if env_extra:
        env.update(env_extra)

    if log_file:
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        with open(log_file, 'w', encoding='utf-8') as f:
            rc = subprocess.call(cmd, cwd=ROOT, env=env, stdout=f, stderr=subprocess.STDOUT)
        try:
            with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
                print(f.read(), flush=True)
        except Exception:
            pass
        print('  -> 已写入 %s' % os.path.relpath(log_file, ROOT), flush=True)
    else:
        rc = subprocess.call(cmd, cwd=ROOT, env=env)
    return rc


# ---------------- 各步骤的「做完了吗」判断 ----------------

def gen_done():
    """数据生成：累计时长达到目标就算完成。

    时长记在 data 目录的 _progress.json 里，所以重启之后只看差额，
    不会像以前那样每次都从零计时（更不会删掉已有数据）。
    """
    d = data_dir()
    shards = resume.scan_shards(d, REC_SIZE)
    records = sum(n for _, n in shards)
    if not shards:
        return False, '还没有任何分片'
    # 旧版本生成的数据没有时长记录，这里按 records / rate_hint 估算，
    # 免得把整个目标时长再跑一遍（gen_data 里用的是同一套逻辑）
    done_sec, estimated = elapsed_seconds(d, CONFIG['rate_hint'])
    prog = resume.read_progress(d)
    target = float(prog.get('minutes_target') or CONFIG['minutes']) * 60
    detail = '%d 个分片 / %d 条记录，累计 %.0f 分钟%s' % (
        len(shards), records, done_sec / 60, '（估算）' if estimated else '')
    if done_sec + 1e-6 >= target:
        return True, detail + '（已达目标 %.0f 分钟）' % (target / 60)
    return False, detail + '（目标 %.0f 分钟，还差 %.0f 分钟）' % (
        target / 60, max(target - done_sec, 0) / 60)


def train_done():
    logs = logs_dir()
    ckpt = os.path.join(logs, 'ckpt.pt')
    if not os.path.isfile(ckpt):
        return False, '还没有 checkpoint'
    try:
        import torch
        ck = torch.load(ckpt, map_location='cpu', weights_only=False)
    except Exception as e:
        return False, 'checkpoint 读不出来（%s）' % e
    ep = int(ck.get('epoch', 0))
    want = CONFIG['epochs']
    if ep >= want:
        return True, '已训到第 %d 轮（目标 %d 轮）' % (ep, want)
    return False, '已训到第 %d 轮（目标 %d 轮，可续训）' % (ep, want)


def _file_done(rel, what):
    p = os.path.join(results_dir(), rel)
    if os.path.isfile(p):
        return True, '%s 已存在（%s）' % (what, os.path.relpath(p, ROOT))
    return False, '还没有 %s' % what


def export_done():
    n = net_path()
    if not os.path.isfile(n):
        return False, '还没有导出网络'
    w = os.path.join(logs_dir(), 'weights.pt')
    if os.path.isfile(w) and os.path.getmtime(n) < os.path.getmtime(w):
        return False, '网络比权重旧，需要重新导出'
    return True, '已导出 %s' % os.path.relpath(n, ROOT)


# ---------------- 各步骤 ----------------

def stage_selfcheck(args):
    return run([sys.executable, 'src/selfcheck.py'])


def stage_gen(args):
    cmd = [sys.executable, 'src/gen_data.py',
           '--workers', str(CONFIG['workers']),
           '--depth', str(CONFIG['depth']),
           '--opening-plies', str(CONFIG['opening_plies']),
           '--minutes', str(CONFIG['minutes']),
           '--out', CONFIG['data_dir']]
    if args.fresh:
        cmd.append('--fresh')
    return run(cmd)


def stage_stats(args):
    return run([sys.executable, 'src/dataset_info.py', '--data', CONFIG['data_dir']],
               log_file=os.path.join(results_dir(), '01-dataset-info.txt'))


def stage_train(args):
    cmd = [sys.executable, 'src/train.py',
           '--data', CONFIG['data_dir'],
           '--out', CONFIG['logs_dir'],
           '--epochs', str(CONFIG['epochs']),
           '--batch', str(CONFIG['batch']),
           '--lr', str(CONFIG['lr']),
           '--l1', str(CONFIG['l1']),
           '--l2', str(CONFIG['l2'])]
    if args.fresh:
        cmd.append('--fresh')
    return run(cmd)


def stage_export(args):
    return run([sys.executable, 'src/export.py',
                '--weights', os.path.join(CONFIG['logs_dir'], 'weights.pt'),
                '--out', os.path.join(CONFIG['logs_dir'], CONFIG['net_name'])],
               log_file=os.path.join(results_dir(), '02-export.txt'))


def stage_verify(args):
    return run([sys.executable, 'src/verify.py',
                '--data', CONFIG['data_dir'], '--net', net_path(),
                '--samples', '4000', '--show', '3'],
               log_file=os.path.join(results_dir(), '03-verify.txt'))


def stage_eval(args):
    return run([sys.executable, 'tests/eval_net_strength.py',
                '--data', CONFIG['data_dir'], '--net', net_path(),
                '--positions', str(CONFIG['eval_positions']),
                '--multipv', str(CONFIG['eval_multipv']),
                '--depth', str(CONFIG['eval_depth']),
                '--seed', '7',
                '--dump', os.path.join(CONFIG['results_dir'], 'positions.json')],
               log_file=os.path.join(results_dir(), '04-strength.txt'))


def stage_handcrafted(args):
    if not shutil.which('node'):
        print('  [跳过] 没找到 node.js，手写评估对照跑不了。')
        print('         装好 Node.js 之后可以单独补跑：')
        print('           node tests/eval_handcrafted.js results/positions.json results/ranks.json')
        return 0
    return run(['node', 'tests/eval_handcrafted.js',
                os.path.join(CONFIG['results_dir'], 'positions.json'),
                os.path.join(CONFIG['results_dir'], 'ranks.json')],
               log_file=os.path.join(results_dir(), '05-handcrafted.txt'))


def stage_package(args):
    """把关键产物汇总到 results/，方便打包回传。这一步很便宜，每次都跑。"""
    rd = results_dir()
    os.makedirs(rd, exist_ok=True)
    for src in (net_path(),
                os.path.join(logs_dir(), 'train.log'),
                os.path.join(logs_dir(), 'ckpt.pt')):
        if os.path.isfile(src):
            shutil.copy2(src, rd)
    print('  已把网络、训练日志、checkpoint 复制到 %s' % os.path.relpath(rd, ROOT))
    for name in sorted(os.listdir(rd)):
        print('    %s' % name)
    return 0


STAGES = [
    # key     标题                        跑什么            做完了吗            每次都跑
    ('check', '环境自检',                  stage_selfcheck,  lambda: (False, '每次都跑（10 秒）'), True),
    ('gen',   '生成自对弈数据（可续跑）',   stage_gen,        gen_done,        False),
    ('stats', '数据规模统计（唯一局面率）', stage_stats,      lambda: _file_done('01-dataset-info.txt', '统计报告'), False),
    ('train', '训练网络（可续训）',         stage_train,      train_done,      False),
    ('export', '导出 .xqnn + 复现校验',     stage_export,     export_done,     False),
    ('verify', '拟合质量报告',              stage_verify,     lambda: _file_done('03-verify.txt', '拟合报告'), False),
    ('eval',  '判断力评估（500 局面）',     stage_eval,       lambda: _file_done('04-strength.txt', '判断力报告'), False),
    ('craft', '手写评估对照 + 配对检验',    stage_handcrafted, lambda: _file_done('05-handcrafted.txt', '对照报告'), False),
    ('pack',  '汇总产物到 results/',        stage_package,    lambda: (False, '每次都跑'),        True),
]


def cmd_status():
    print('=' * 68)
    print('流程状态：%s' % ROOT)
    print('=' * 68)
    for i, (key, title, _fn, check, always) in enumerate(STAGES, 1):
        done, detail = check()
        mark = 'OK  ' if (done and not always) else '待跑'
        print('  [%d/%d] %-8s %-26s %s' % (i, len(STAGES), mark, title, detail))
    print('=' * 68)
    print('  已完成的步骤会被跳过；要全部重跑加 --fresh，要指定步骤就写 key：')
    print('    python src/pipeline.py run --fresh')
    print('    python src/pipeline.py run gen train')
    return 0


def cmd_run(args):
    wanted = args.stages or [k for k, *_ in STAGES]
    bad = [k for k in wanted if k not in [s[0] for s in STAGES]]
    if bad:
        print('未知步骤：%s（可用：%s）' % (', '.join(bad), ', '.join(s[0] for s in STAGES)))
        return 2

    os.makedirs(results_dir(), exist_ok=True)
    ran = skipped = 0
    t0 = time.time()
    for i, (key, title, fn, check, always) in enumerate(STAGES, 1):
        if key not in wanted:
            continue
        print()
        print('=' * 68)
        print('[%d/%d] %s' % (i, len(STAGES), title))
        print('=' * 68)
        done, detail = check()
        if args.fresh or always:
            done = False
        if done:
            print('  跳过（%s）' % detail)
            print('  若想重跑这一步：先删掉对应产物，或整体加 --fresh')
            skipped += 1
            continue
        print('  状态：%s' % detail)
        print('  开始于 %s' % time.strftime('%H:%M:%S'))
        rc = fn(args)
        if rc != 0:
            print()
            print('=' * 68)
            print('失败：步骤「%s」返回 %d，已停下。' % (title, rc))
            print('=' * 68)
            print('  常见原因：')
            print('   1. engine\\ 里缺 pikafish.exe / pikafish.nnue')
            print('   2. PyTorch 装成了 CPU 版（跑 0-fix-torch.bat 再跑 1-install.bat）')
            print('   3. 磁盘不够（生成数据要 6~8 GB）')
            print('  修好之后直接重新运行本脚本：已完成的步骤会自动跳过。')
            return rc
        print('  完成于 %s' % time.strftime('%H:%M:%S'))
        ran += 1

    print()
    print('=' * 68)
    print('全部完成：跑了 %d 步，跳过 %d 步，用时 %.1f 分钟'
          % (ran, skipped, (time.time() - t0) / 60))
    print('产物目录：%s' % os.path.relpath(results_dir(), ROOT))
    print('=' * 68)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='一键全流程（带断点恢复）')
    sub = ap.add_subparsers(dest='cmd')
    sub.add_parser('status', help='只看状态，不跑东西')
    r = sub.add_parser('run', help='跑流程')
    r.add_argument('stages', nargs='*', help='只跑这些步骤（默认全部）')
    r.add_argument('--fresh', action='store_true', help='忽略断点，全部重跑')
    args = ap.parse_args(argv)

    if args.cmd == 'status':
        return cmd_status()
    if args.cmd == 'run':
        return cmd_run(args)
    ap.print_help()
    return 1


if __name__ == '__main__':
    sys.exit(main() or 0)
