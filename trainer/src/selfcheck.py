"""
环境自检。拿到训练包后先跑这个，确认环境就绪再开始跑数据。

    python selfcheck.py
    python selfcheck.py --engine D:\\pikafish\\pikafish.exe

任何一项不通过都会给出具体的处理建议，而不是只丢一个报错。
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
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

OK, WARN, FAIL = '  [OK]  ', '  [警告]', '  [失败]'

problems = []


def line(mark, title, detail=''):
    print('%s %s' % (mark, title))
    if detail:
        for d in detail.split('\n'):
            print('          %s' % d)


def check_python():
    v = sys.version_info
    ver = '%d.%d.%d' % (v.major, v.minor, v.micro)
    if v.major == 3 and v.minor >= 9:
        line(OK, 'Python 版本 %s' % ver)
        return True
    line(FAIL, 'Python 版本 %s（需要 3.9 或更高）' % ver)
    problems.append('Python 版本过低')
    return False


def check_numpy():
    try:
        import numpy
        line(OK, 'numpy %s' % numpy.__version__)
        return True
    except ImportError:
        line(FAIL, 'numpy 未安装', '执行：pip install numpy')
        problems.append('numpy 缺失')
        return False


def check_torch():
    try:
        import torch
    except ImportError:
        line(FAIL, 'PyTorch 未安装',
             '如果显卡是 N 卡，装 CUDA 版（2080Ti 需要 cu121 或更高）：\n'
             'pip install torch --index-url https://download.pytorch.org/whl/cu121')
        problems.append('torch 缺失')
        return None

    line(OK, 'PyTorch %s' % torch.__version__)

    if torch.cuda.is_available():
        try:
            name = torch.cuda.get_device_name(0)
            cap = torch.cuda.get_device_capability(0)
            mem = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
            line(OK, 'CUDA 可用：%s' % name,
                 '计算能力 sm_%d%d，显存 %.1f GB，CUDA %s'
                 % (cap[0], cap[1], mem, torch.version.cuda))
            return 'cuda'
        except Exception as e:
            line(WARN, 'CUDA 报告可用但读取设备信息失败: %s' % e)
            return 'cuda'

    # 没 CUDA 也不是走不了，只是慢很多
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        line(WARN, '未检测到 CUDA，将使用 Apple MPS 加速')
        return 'mps'

    line(WARN, '未检测到 CUDA，只能跑 CPU',
         '训练会慢很多（可能 5~10 倍）。如果机器上有 N 卡，\n'
         '多半是装成了 CPU 版 torch，重装 CUDA 版即可。')
    problems.append('没有 GPU 加速')
    return 'cpu'


def find_engine(explicit):
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    patterns = [
        os.path.join(ROOT, 'engine', 'pikafish*.exe'),
        os.path.join(ROOT, 'engine', 'pikafish'),
        os.path.join(ROOT, 'engine', '**', 'pikafish*.exe'),
        os.path.join(ROOT, 'engine', '**', 'pikafish'),
    ]
    for pat in patterns:
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            return hits[0]
    return None


def check_engine(path):
    if not path:
        line(FAIL, '未找到 Pikafish 引擎',
             '把解压出来的 pikafish 可执行文件放进 trainer\\engine\\ 目录，\n'
             '或者用 --engine 参数指定完整路径。\n'
             '下载：https://github.com/official-pikafish/Pikafish/releases')
        problems.append('引擎缺失')
        return None

    line(OK, '引擎文件：%s' % path, '大小 %.1f MB' % (os.path.getsize(path) / 1024 / 1024))

    nnue = None
    for cand in glob.glob(os.path.join(os.path.dirname(path), '*.nnue')):
        nnue = cand
        break
    if nnue:
        line(OK, 'NNUE 权重：%s' % os.path.basename(nnue),
             '大小 %.1f MB' % (os.path.getsize(nnue) / 1024 / 1024))
    else:
        line(WARN, '同目录下没有找到 .nnue 权重文件',
             '引擎在 EvalFile 默认位置找不到权重时会直接退出。\n'
             '把发布包里的 pikafish.nnue 放到引擎同目录即可。')
    return path, nnue


def check_engine_runs(path):
    """真的启动一次，确认能跑、权重能加载。"""
    sys.path.insert(0, HERE)
    try:
        from uci import UciEngine, EngineError
    except ImportError as e:
        line(FAIL, '无法导入 uci 模块: %s' % e)
        problems.append('模块导入失败')
        return
    eng = None
    try:
        eng = UciEngine(path, threads=1, hash_mb=32)
        bestmove, cands = eng.go([], depth=4)
        cp = cands[0]['cp'] if cands else None
        line(OK, '引擎启动并搜索成功',
             '开局 depth 4 给出着法 %s，评估 %s 分' % (bestmove, cp))
    except EngineError as e:
        line(FAIL, '引擎启动失败：%s' % e,
             '常见原因：权重文件缺失或版本不匹配。\n'
             '试着在命令行手动跑一次引擎，看它打印什么。')
        problems.append('引擎无法启动')
    except Exception as e:
        line(FAIL, '引擎测试异常：%s: %s' % (type(e).__name__, e))
        problems.append('引擎测试异常')
    finally:
        if eng:
            eng.quit()


def check_disk():
    total, used, free = shutil.disk_usage(ROOT)
    gb = free / 1024 ** 3
    if gb >= 30:
        line(OK, '磁盘剩余 %.0f GB' % gb)
    elif gb >= 10:
        line(WARN, '磁盘剩余 %.0f GB，可能不够' % gb,
             '1 亿个局面约占 9.3 GB。建议留出 30 GB 以上。')
    else:
        line(FAIL, '磁盘剩余仅 %.0f GB' % gb,
             '1 亿个局面约占 9.3 GB。请清理磁盘或调小 --minutes。')
        problems.append('磁盘空间不足')


def check_cpu():
    n = os.cpu_count() or 0
    if n >= 8:
        line(OK, 'CPU %d 个逻辑核心' % n, '数据生成阶段建议用 %d 个并行进程' % max(1, n - 2))
    else:
        line(WARN, 'CPU 只有 %d 个逻辑核心' % n,
             '数据生成会偏慢，建议把 --workers 调小并延长运行时间。')


def main():
    ap = argparse.ArgumentParser(description='训练包环境自检')
    ap.add_argument('--engine', default=None, help='Pikafish 可执行文件路径')
    args = ap.parse_args()

    print('=' * 64)
    print('象棋 NNUE 训练包 · 环境自检')
    print('=' * 64)
    print('工作目录: %s' % ROOT)
    print()

    check_python()
    check_numpy()
    device = check_torch()
    check_cpu()
    check_disk()

    print()
    engine_path = find_engine(args.engine)
    found = check_engine(engine_path)
    if found:
        check_engine_runs(found[0])

    print()
    print('=' * 64)
    if not problems:
        print('全部就绪，可以开始跑了。')
        print()
        print('建议流程（Windows）：')
        print('  1-install.bat      安装依赖')
        print('  2-gen-data.bat     生成训练数据（可挂机跑几小时）')
        print('  3-train.bat        训练网络')
        print('  4-export.bat       导出并验证')
    else:
        print('发现 %d 个问题：' % len(problems))
        for p in problems:
            print('  - %s' % p)
        print()
        print('按上面的建议处理后重新运行本脚本。')
    print('=' * 64)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
