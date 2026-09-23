# 从 Mac 远程操作 Windows

现在改一次搜索、看一次结果要这样：Mac 上改 → 打包 → 拷到 Win → 跑 → 把日志拷回来 →
读 → 发现还要改。一个来回十几分钟，拿到的还是几小时前的快照。

接上 SSH 之后，这些全是一条命令的事：看进度、拉日志、查 CPU、杀残留进程、甚至直接
在那边改文件。**下面是一次性配置，做完之后就不用再传话了。**

---

## 一、Windows 侧：装内置的 OpenSSH Server

Win10 1809+ / Win11 自带，**不需要装任何第三方软件**。

用**管理员**身份打开 PowerShell（开始菜单搜 PowerShell → 右键「以管理员身份运行」），
逐行粘贴：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

装完启动服务并设为开机自启：

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

放行 22 端口（Windows 防火墙默认拦所有入站）：

```powershell
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

验证一下：

```powershell
Get-Service sshd
```

看到 `Running` 就成了。

> **必须开机自启。** 这台机器是跑 10 小时长任务的，半夜重启（比如 Windows 自动更新）
> 之后如果 sshd 没起来，第二天就连不上了 —— 那正是最需要远程看一眼的时候。

---

## 二、免密登录

在 **Mac** 上生成一对专门给这台机器用的密钥（别再复用别的 key）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/win_xq -N "" -C "mac-to-win-xq"
cat ~/.ssh/win_xq.pub
```

把打印出来的**整行**（以 `ssh-ed25519` 开头）复制下来。

### ⚠️ 这里有个大坑：看你的账号是不是管理员

Windows 的 OpenSSH 对**管理员账号**和**普通账号**读的是**两个不同的文件**，而且用错了
**不会报错**，只会一直让你输密码，非常难查。

**普通账号** → 写进用户自己的 `authorized_keys`：

```powershell
$k = 'ssh-ed25519 AAAAC3Nza... mac-to-win-xq'
Add-Content -Path "$env:USERPROFILE/.ssh/authorized_keys" -Value $k
```

**管理员账号** → 必须写进 `C:/ProgramData/ssh/administrators_authorized_keys`，
而且权限必须是 SYSTEM 和 Administrators 独占：

```powershell
$k = 'ssh-ed25519 AAAAC3Nza... mac-to-win-xq'
$f = "$env:ProgramData/ssh/administrators_authorized_keys"
Add-Content -Path $f -Value $k
icacls $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

`icacls` 那行不能省 —— 文件权限多出任何一条别的条目，sshd 都会**静默忽略**它。

### 在 Mac 上加个别名

编辑 `~/.ssh/config`：

```
Host win
    HostName 192.168.1.23
    User 你的Windows用户名
    IdentityFile ~/.ssh/win_xq
```

（`HostName` 换成 Windows 的局域网 IP，在那边跑 `ipconfig` 看「IPv4 地址」。
想用 Tailscale/cpolar 的话见第四节。）

试一下：

```bash
ssh win "echo 连上了"
```

能直接打印出「连上了」就成功，不该再问密码。

---

## 三、Mac 侧：`tools/win.sh`

先告诉它去操作哪个目录（写进 `~/.zshrc` 免得每次设）：

```bash
export XQ_WIN_HOST=win
export XQ_WIN_DIR='C:/Users/你的用户名/Desktop/xiangqi-coach'
```

然后：

```bash
tools/win.sh status           # 流程跑到哪一步（哪份产物还没出，直接点名）
tools/win.sh tail 40          # 对局报告最后 40 行 —— 这就是以前要你手抄给我的东西
tools/win.sh log 40           # 最新一份日志的最后 40 行
tools/win.sh load             # CPU 占用 + node/python 进程
tools/win.sh procs            # 只列 node 进程（找残留 worker）
tools/win.sh kill-node        # 杀掉所有 node 进程
tools/win.sh ls               # 列工作目录
tools/win.sh pull results/ab-result-all.txt    # 拉回本地
tools/win.sh run "Get-Date"   # 在那边跑任意 PowerShell
```

**`procs` 和 `kill-node` 这两个不是凑数的。** 已经踩过一次：对局台的主进程被打断后，
它 fork 出来的 worker 没人管，继续满核跑 —— 表面看「已经停了」，实际上后续每一次
测量都在跟它们抢 CPU，同一批 4 局从 2 秒变成 3 分钟，而且**不报任何错**。
现在对局台自己会清理（收到中断信号就把 worker 一起带走，另有一道「父进程没了就退出」
的保险），但远程能一眼看到进程表总是好的。

---

## 四、不在同一个局域网怎么办

上面第二节用的是局域网 IP，出了家门就连不上。两个办法：

### 办法 A：Tailscale（推荐）

两台机器都装 [Tailscale](https://tailscale.com/download)、登录**同一个账号**。
它会给你一个 `100.x.y.z` 的私有地址，两台机器之间直连，不需要公网 IP、不需要端口映射。

然后 `~/.ssh/config` 里的 `HostName` 换成那个 `100.x.y.z` 就行，其余不变。

### 办法 B：复用已有的 cpolar

这台机器上已经在用 cpolar 发布 IM 服务了，同一个账号可以再开一条 TCP 隧道：

```
cpolar tcp 22
```

它会打印一个 `x.tcp.cpolar.cn:12345` 这样的地址，然后：

```bash
ssh -p 12345 你的Windows用户名@x.tcp.cpolar.cn
```

免费版的隧道地址每次重启会变，所以只适合临时用；长期用还是 Tailscale。

---

## 五、常见问题

**`ssh win` 一直要密码**
按第二节分清楚是管理员账号还是普通账号 —— 十有八九是写错了文件，或者
`administrators_authorized_keys` 的权限没清干净（`icacls` 那行）。

**`Connection refused`**
Windows 上 `Get-Service sshd` 看服务起没起；没起就 `Start-Service sshd`，
并且确认 `StartupType` 是 `Automatic`。

**`Connection timed out`**
防火墙那条规则没加，或者 IP 变了（路由器换了 DHCP 租约）。先在 Windows 上
`ipconfig` 确认 IP。

**连上之后中文乱码**
Windows 的默认代码页是 GBK。执行命令前先切一下：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

`tools/win.sh` 里的命令都不含中文输出，所以不受影响；你自己随手发命令时可能需要。

**想改默认 shell 成 PowerShell（可选）**
`tools/win.sh` 已经对每条命令显式指定了解释器，所以**这一步不做也没关系**。
真想做的话，注册表路径里有个反斜杠，在 Mac 上敲要小心转义，建议直接复制过去：

```powershell
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force
```

---

## 六、连上之后最常用的三件事

```bash
# 1. 看长任务跑到哪了
tools/win.sh status

# 2. 把结果拿回来分析（不用你再手动拷）
tools/win.sh pull results/ab-result-all.txt

# 3. 那边跑得不对，直接改文件重跑
tools/win.sh run "cd 'C:/Users/你/Desktop/xiangqi-coach'; node tools/match.js --perft 3"
```
