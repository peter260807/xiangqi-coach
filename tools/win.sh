#!/usr/bin/env bash
#
# 从这台 Mac 直接操作 Windows 那台跑训练/对局的机器。
#
# 为什么要有它：以前每改一行代码、每看一次结果，都要「Mac 上改 → 打包 → 拷过去
# → 跑 → 把日志拷回来 → 读」，一个来回十几分钟，而且拿到的往往是几小时前的快照。
# 接上 SSH 之后，看进度、拉日志、杀进程、甚至直接改文件都是一条命令。
#
# 前置（一次性，见 docs/remote-windows.md）：
#   1. Windows 装上内置的 OpenSSH Server，并放行 22 端口
#   2. Mac 的 ~/.ssh/config 里有一个 Host 别名（默认叫 win）
#   3. 下面两个环境变量（建议写进 ~/.zshrc）：
#        export XQ_WIN_HOST=win
#        export XQ_WIN_DIR='C:/Users/你/Desktop/xiangqi-coach'
#
# 用法：
#   tools/win.sh status              # 看流程跑到哪一步（等价于 pipeline.py status）
#   tools/win.sh tail [n]            # 看对局报告最后 n 行（默认 30）
#   tools/win.sh log [n]             # 看最新一份日志最后 n 行
#   tools/win.sh load                # CPU 占用 + node/python 进程
#   tools/win.sh procs               # 只列 node 进程（找残留 worker 用）
#   tools/win.sh kill-node           # 杀掉所有 node 进程（清残留）
#   tools/win.sh ls                  # 列工作目录
#   tools/win.sh pull <远端路径> [本地文件名]
#   tools/win.sh run <PowerShell…>   # 在 Win 上跑任意命令
#   tools/win.sh sh <命令…>           # 在 Win 上跑任意 cmd 命令
#
set -euo pipefail

HOST="${XQ_WIN_HOST:-win}"
DIR="${XQ_WIN_DIR:-}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")

if [ -z "$DIR" ]; then
  cat >&2 <<'EOF'
还没告诉我要操作 Windows 上的哪个目录。先设一个环境变量，例如：

  export XQ_WIN_HOST=win
  export XQ_WIN_DIR='C:/Users/你/Desktop/xiangqi-coach'

（写进 ~/.zshrc 就不用每次设了。）
EOF
  exit 2
fi

# 所有远程命令都显式指定 PowerShell —— Windows 上 sshd 的默认 shell 可能是
# cmd.exe，那样 `cd 'C:/...'` 和分号写法都不成立。写死解释器就不用猜。
ps() {
  "${SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$1\""
}

act="${1:-help}"
[ $# -gt 0 ] && shift

case "$act" in
  status)
    ps "cd '$DIR'; python src/pipeline.py status"
    ;;

  tail)
    n="${1:-30}"
    ps "cd '$DIR'; if (Test-Path 'results/ab-result-all.txt') { Get-Content 'results/ab-result-all.txt' -Tail $n } else { Write-Output '还没产出 results/ab-result-all.txt' }"
    ;;

  log)
    n="${1:-30}"
    ps "cd '$DIR'; \$f = Get-ChildItem -Path . -Filter '*.txt' -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (\$f) { Write-Output ('-- ' + \$f.FullName); Get-Content \$f.FullName -Tail $n } else { Write-Output '没找到 txt 日志' }"
    ;;

  load)
    ps "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage; Get-Process node,python -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,@{n='MemMB';e={[int](\$_.WS/1MB)}} | Format-Table -AutoSize"
    ;;

  procs)
    # 只列 node：跑完一场对局台本该一个都不剩，还留着就是残留 worker。
    ps "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,CPU,StartTime,@{n='MemMB';e={[int](\$_.WS/1MB)}} | Format-Table -AutoSize"
    ;;

  kill-node)
    ps "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Write-Output '已终止所有 node 进程'"
    ;;

  ls)
    ps "cd '$DIR'; Get-ChildItem | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize"
    ;;

  pull)
    f="${1:?用法: tools/win.sh pull <远端相对路径> [本地文件名]}"
    out="${2:-$(basename "$f")}"
    # 走 PowerShell 打印而不是 scp：Windows 的盘符路径在 scp 里认法不统一
    # （C:/ 还是 /C:/ 取决于版本），直接 cat 出来最省事。
    ps "cd '$DIR'; Get-Content '$f' -Raw" > "$out"
    echo "已拉回 → $out（$(wc -l < "$out" | tr -d ' ') 行）"
    ;;

  run)
    ps "$*"
    ;;

  sh)
    "${SSH[@]}" "$*"
    ;;

  *)
    sed -n '10,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
