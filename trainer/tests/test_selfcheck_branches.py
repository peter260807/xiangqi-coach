"""用假 torch 模块，把 Windows 上各种 GPU 情况都逼出来验证诊断是否准确。
本机没有 CUDA 也没有 nvidia-smi，这些分支否则永远不会被执行到。"""
import os, sys, types

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
import selfcheck as SC


class _T:
    def __matmul__(self, o): return self
    def sum(self): return self
    def item(self): return 0.0


def fake_torch(ver, cuda_tag, avail, calc_fail=False):
    m = types.ModuleType('torch')
    m.__version__ = ver
    m.version = types.SimpleNamespace(cuda=cuda_tag)
    cuda = types.SimpleNamespace()
    cuda.is_available = lambda: avail
    cuda.get_device_name = lambda i: 'NVIDIA GeForce RTX 2080 Ti'
    cuda.get_device_capability = lambda i: (7, 5)
    cuda.get_device_properties = lambda i: types.SimpleNamespace(
        name='NVIDIA GeForce RTX 2080 Ti', total_memory=11 * 1024 ** 3)
    cuda.synchronize = lambda: None
    m.cuda = cuda

    def randn(*a, **k):
        if calc_fail:
            raise RuntimeError('no kernel image is available for execution on the device')
        return _T()
    m.randn = randn
    m.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: False))
    return m


SM = 'NVIDIA GeForce RTX 2080 Ti, 566.03'
CASES = [
    ('A  CPU版 + 机器有显卡（最可能踩的坑）', ('2.8.0', None, False, False), SM,   'cpu',
     'torch 装成了 CPU 版'),
    ('B  CPU版 + 没有显卡',                    ('2.8.0', None, False, False), None, 'cpu', None),
    ('C  CUDA版 + 驱动太旧',                   ('2.8.0+cu126', '12.6', False, False), SM, 'cpu',
     'CUDA 不可用'),
    ('D  一切正常',                            ('2.8.0+cu126', '12.6', True, False), SM, 'cuda', None),
    ('E  能查到设备，但一算就炸',               ('2.8.0+cu126', '12.6', True, True), SM, 'cpu',
     'CUDA 无法实际运算'),
]

ok = True
for name, args, smi, expect_dev, expect_prob in CASES:
    sys.modules['torch'] = fake_torch(*args)
    SC.nvidia_smi = (lambda v: (lambda: v))(smi)
    SC.problems = []
    print('=' * 64)
    print(name)
    print('=' * 64)
    got = SC.check_torch()
    hit_dev = (got == expect_dev)
    hit_prob = True if expect_prob is None else (expect_prob in SC.problems)
    ok = ok and hit_dev and hit_prob
    print('  --> device=%r（期望 %r）%s' % (got, expect_dev, 'OK' if hit_dev else '  不符'))
    print('      问题记录=%s%s' % (SC.problems or '无',
                                  '' if hit_prob else '   <-- 不符，期望含 %r' % expect_prob))
    print()

print('=' * 64)
print('全部符合预期' if ok else '有分支不符合预期')
sys.exit(0 if ok else 1)
