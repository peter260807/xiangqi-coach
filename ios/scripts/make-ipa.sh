#!/bin/bash
#
# 打 iOS 安装包（ad hoc / development），可选直接装到连着的数据线设备上。
#
#   ./ios/scripts/make-ipa.sh                     # ad hoc（推荐）
#   ./ios/scripts/make-ipa.sh --development       # 开发签名（不需要 Ad Hoc 描述文件）
#   ./ios/scripts/make-ipa.sh --udid 00008112-... # 打完后校验该设备在授权名单里
#   ./ios/scripts/make-ipa.sh --devices           # 列出当前连着/配对过的设备及其 UDID
#   ./ios/scripts/make-ipa.sh --list-devices      # 列出本机描述文件及其授权设备
#   ./ios/scripts/make-ipa.sh --install <UDID>    # 打完直接装上去（可配合 --development）
#
# 为什么要有 --udid 这个校验：
# ad hoc / development 包只能装进描述文件的 ProvisionedDevices 名单。
# 名单里没有这台设备时，安装会失败并报一句很含糊的
# "无法安装此 App" 或 "Unable to Install"，肉眼完全看不出是签名名单的问题。
# 与其让用户在 iPad 上对着报错发呆，不如在这里打之前就把话说清楚。
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IOS="$ROOT/ios"
OUT="$ROOT/.workbuddy/outputs"
APP_NAME="象棋教练"
BUNDLE_ID="com.peter260807.xiangqicoach"

MODE="adhoc"
WANT_UDID=""
LIST_ONLY=0
INSTALL_TO=""
LIST_DEV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --development|--debugging) MODE="development"; shift ;;
    --adhoc)                   MODE="adhoc"; shift ;;
    --udid)                    WANT_UDID="${2:-}"; shift 2 ;;
    --list-devices)            LIST_ONLY=1; shift ;;
    --devices)                 LIST_DEV=1; shift ;;
    --install)                 INSTALL_TO="${2:-}"; shift 2 ;;
    --install=*)               INSTALL_TO="${1#*=}"; shift ;;
    -h|--help)                 sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

export PATH=/Users/GoodHarvest/homebrew/bin:$PATH

say()  { printf '%s\n' "$*"; }
fail() { printf '\n[失败] %s\n' "$*" >&2; exit 1; }

# ---------- 工具 ----------

# 把 IPA 里的 embedded.mobileprovision 解出来，返回 plist 路径
profile_of_ipa() {
  local ipa="$1" tmp
  tmp="$(mktemp -d)"
  unzip -qo "$ipa" -d "$tmp" || return 1
  local emb
  emb="$(find "$tmp/Payload" -maxdepth 2 -name embedded.mobileprovision | head -1)"
  [ -n "$emb" ] || { rm -rf "$tmp"; return 1; }
  security cms -D -i "$emb" > "$tmp/pp.plist" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  echo "$tmp/pp.plist"
}

# .mobileprovision 是 CMS 签名包，不是纯 plist —— 必须先 security cms -D 解码，
# 直接把文件喂给 PlistBuddy 会安静地读不到任何字段（踩过一次，设备清单显示为空）。
# 返回解码后的 plist 路径（临时文件，调用方负责删）。
decode_profile() {
  local out
  out="$(mktemp -t pp)"
  if ! security cms -D -i "$1" > "$out" 2>/dev/null || [ ! -s "$out" ]; then
    rm -f "$out"; return 1
  fi
  echo "$out"
}

# 取描述文件的某个字段
pp_field() {
  local f="$1" key="$2" tmp v
  tmp="$(decode_profile "$f")" || return 1
  v="$(/usr/libexec/PlistBuddy -c "Print :$key" "$tmp" 2>/dev/null)"
  rm -f "$tmp"
  [ -n "$v" ] && printf '%s\n' "$v"
}

# 从**已解码**的 plist 里取授权设备
devices_in_plist() {
  /usr/libexec/PlistBuddy -c "Print :ProvisionedDevices" "$1" 2>/dev/null \
    | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}' | sort -u
}

# 从 .mobileprovision（CMS 签名包）里取授权设备
devices_of_profile() {
  local tmp
  tmp="$(decode_profile "$1")" || return 1
  devices_in_plist "$tmp"
  rm -f "$tmp"
}

# 生成时间（epoch 秒）。用来在「同名候选有多份」时选**最新**的那一份。
pp_epoch() {
  local tmp
  tmp="$(decode_profile "$1")" || { echo 0; return; }
  # plist 里的日期是 **UTC**，而 plistlib 解出来的是 naive datetime。
  # 直接 .timestamp() 会按本地时区解释，显示时间差 8 小时（排序不受影响，但看日志会误判）。
  /usr/bin/python3 - "$tmp" <<'PY' 2>/dev/null || echo 0
import plistlib, sys
from datetime import timezone
with open(sys.argv[1], 'rb') as f:
    d = plistlib.load(f)
c = d.get('CreationDate')
print(int(c.replace(tzinfo=timezone.utc).timestamp()) if c else 0)
PY
  rm -f "$tmp"
}

# 一份描述文件「重新生成」后**名字不变**，只有 UUID 变 —— 所以导出时不能只给名字。
profile_uuid() {
  pp_field "$1" UUID
}

# 描述文件会落在**两个**位置，两处都得扫：
#   用户手动安装的      -> ~/Library/MobileDevice/Provisioning Profiles/
#   Xcode 托管/同步来的 -> ~/Library/Developer/Xcode/UserData/Provisioning Profiles/
# 实测用户从后台下载双击后，文件落在后者。只扫前者会出现
# "明明装好了，脚本却说没有" —— 找半天找不到原因。
PROFILE_DIRS=(
  "$HOME/Library/MobileDevice/Provisioning Profiles"
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
)

all_profiles() {
  local d f
  for d in "${PROFILE_DIRS[@]}"; do
    [ -d "$d" ] || continue
    for f in "$d"/*.mobileprovision; do
      [ -f "$f" ] && printf '%s\n' "$f"
    done
  done
}

# ---------- 事先把配置和描述文件找齐 ----------

PROFILE_NAME=""
TEAM_ID="${TEAM_ID:-}"

ADHOC_PLIST="$OUT/exportOptions-adhoc.plist"
if [ -f "$ADHOC_PLIST" ]; then
  [ -n "$TEAM_ID" ] && : || TEAM_ID="$(/usr/libexec/PlistBuddy -c "Print :teamID" "$ADHOC_PLIST" 2>/dev/null)"
  # signingStyle=manual 时才有 provisioningProfiles 映射
  PROFILE_NAME="$(/usr/libexec/PlistBuddy -c "Print :provisioningProfiles:$BUNDLE_ID" "$ADHOC_PLIST" 2>/dev/null)"
fi

# 已安装的 .mobileprovision —— 选哪一份
#
# ⚠️ 一份描述文件**重新生成后名字通常不变**（都叫 "XC Wildcard"），只有 UUID 变。
#    于是「按名字找」会同时命中新旧两份，选到哪一份取决于目录顺序 ——
#    而旧的那份不含新加的设备，装上去就报 0xe8008012（错误信息完全指不到这一点）。
#    所以选择分两轮：
#      第 1 轮：**含目标设备**的那一份（给了 --udid 时）
#      第 2 轮：**生成时间最新**的那一份（新一份通常是旧一份的超集）
PROFILE_PATH=""

# 这份描述文件算候选吗？
#   - 带设备名单（说明是 ad hoc / 开发类，而不是 App Store 分发）
#   - 分发签名（get-task-allow=false）
#   - 给了名字就按名字；否则 application-identifier 要匹配本 App
#     （精确匹配，或团队通配 <团队ID>.*）
is_candidate() {
  local p="$1" aid
  aid="$(pp_field "$p" Entitlements:application-identifier)"
  [ -n "$aid" ] || return 1
  [ "$(pp_field "$p" Entitlements:get-task-allow)" = "true" ] && return 1
  [ -n "$(devices_of_profile "$p")" ] || return 1
  if [ -n "$PROFILE_NAME" ]; then
    [ "$(pp_field "$p" Name)" = "$PROFILE_NAME" ] || return 1
  else
    case "$aid" in
      "${TEAM_ID}.${BUNDLE_ID}"|"${TEAM_ID}.*") ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

if [ -n "$WANT_UDID" ]; then
  while IFS= read -r p; do
    is_candidate "$p" || continue
    if devices_of_profile "$p" | grep -qix "$WANT_UDID"; then
      PROFILE_PATH="$p"
      break
    fi
  done < <(all_profiles)
fi

if [ -z "$PROFILE_PATH" ]; then
  best_ts=-1
  while IFS= read -r p; do
    is_candidate "$p" || continue
    ts="$(pp_epoch "$p" | tr -d '[:space:]')"
    case "$ts" in ''|*[!0-9]*) ts=0 ;; esac
    if [ "$ts" -gt "$best_ts" ]; then best_ts="$ts"; PROFILE_PATH="$p"; fi
  done < <(all_profiles)
fi

if [ -n "$PROFILE_PATH" ]; then
  PROFILE_NAME="$(pp_field "$PROFILE_PATH" Name)"
  PROFILE_UUID="$(profile_uuid "$PROFILE_PATH")"
  # 导出配置里给 **UUID** 而不是名字：重新生成描述文件后名字不变、只有 UUID 变，
  # 本机同时存在新旧两份同名文件时，按名字会让 Xcode 选到旧的那份（不含新设备）。
  EXPORT_PROFILE_KEY="${PROFILE_UUID:-$PROFILE_NAME}"
  # 同名多份时明确说出来 —— 「后台明明加了设备却装不上」最常见的来源就是这个
  SAME_NAME=""
  while IFS= read -r p; do
    [ "$p" = "$PROFILE_PATH" ] && continue
    [ "$(pp_field "$p" Name)" = "$PROFILE_NAME" ] || continue
    SAME_NAME="${SAME_NAME}${SAME_NAME:+、}$(basename "$p")"
  done < <(all_profiles)
  say "描述文件：${PROFILE_NAME}"
  say "  UUID    ：${PROFILE_UUID:-未知}"
  say "  文件    ：$(printf '%s' "$PROFILE_PATH" | sed "s|$HOME|~|")"
  say "  生成于  ：$(date -r "$(pp_epoch "$PROFILE_PATH")" '+%Y-%m-%d %H:%M' 2>/dev/null || echo 未知)"
  say "  设备    ：$(devices_of_profile "$PROFILE_PATH" | grep -c . || true) 台"
  if [ -n "$SAME_NAME" ]; then
    say "  ⚠️  本机还有同名描述文件：$SAME_NAME"
    say "     上面这份是【按目标设备 / 生成时间】挑出来的最新那份；"
    say "     导出时会按 UUID 指定，所以不会选错 —— 但建议把旧的删掉以免以后混淆。"
  fi
fi

# --devices：列出设备、硬件 UDID、以及「开发者模式」是否开启。
#
# 刻意用 devicectl 的 JSON 而不是 `xcrun xctrace list devices`：
#   - xctrace 的分组会滞后，明明插着也常被列进 "Devices Offline"，据此判断会误报
#   - xctrace 拿不到 developerModeStatus，而它正是安装时最容易被静默拦住的一环
#   - 注册到开发者后台要填的是 hardwareProperties.udid，不是 devicectl 的
#     connectionProperties 里的 coredevice UUID（填错白折腾一轮）
if [ "$LIST_DEV" = "1" ]; then
  DEVJSON="$(mktemp -t devicectl)"
  if xcrun devicectl list devices --json-output "$DEVJSON" >/dev/null 2>&1 && [ -s "$DEVJSON" ]; then
    /usr/bin/python3 - "$DEVJSON" <<'PY'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

rows = []
for dev in data.get('result', {}).get('devices', []):
    hw = dev.get('hardwareProperties', {})
    dp = dev.get('deviceProperties', {})
    cp = dev.get('connectionProperties', {})
    rows.append({
        'name': dp.get('name') or '?',
        'udid': hw.get('udid') or '?',
        'model': hw.get('marketingName') or '',
        'os': dp.get('osVersionNumber') or '',
        'conn': {'wired': 'USB 线', 'localNetwork': '无线'}.get(
            cp.get('transportType'), cp.get('transportType') or '?'),
        'dm': {'enabled': '已开启', 'disabled': '未开启'}.get(
            dp.get('developerModeStatus'), dp.get('developerModeStatus') or '未知'),
        'paired': cp.get('pairingState') or '?',
    })

print('=== 设备（注册到开发者后台要填的是「硬件 UDID」）===')
if not rows:
    print('  （没有找到任何设备）')
for r in rows:
    print('')
    print('  %s  —  %s / %s' % (r['name'], r['model'], r['os']))
    print('    硬件 UDID : %s' % r['udid'])
    print('    连接      : %s    配对: %s' % (r['conn'], r['paired']))
    print('    开发者模式: %s' % r['dm'])

print('')
blocked = [r for r in rows if r['dm'] == '未开启']
if blocked:
    print('  ⚠️ 下面这些设备 devicectl 报「开发者模式未开启」：')
    for r in blocked:
        print('       - %s（%s）' % (r['name'], r['udid']))
    print('     打开方式：设置 -> 隐私与安全性 -> 开发者模式 -> 打开，然后重启设备。')
    print('     数据线安装必须开这个，与签名方式无关（ad-hoc 包也一样）。')
    print('')
    print('     ⚠️ 但 developerModeStatus 是随连接一起缓存的，**可能滞后**：')
    print('        实测设备上已经打开、且实际安装已经能过这一关，这里仍报未开启。')
    print('        所以别只信它 —— 以实际安装时报不报 Developer Mode is disabled 为准。')

unpaired = [r for r in rows if r['paired'] != 'paired']
if unpaired:
    print('')
    print('  ⚠️ 下面这些设备还没和这台 Mac 配对，现在装不上去（RemotePairingError 2）：')
    for r in unpaired:
        print('       - %s（%s）' % (r['name'], r['udid']))
    print('     一条命令发起配对，然后在**设备上**点「信任此电脑」并输入锁屏密码：')
    print('       xcrun devicectl manage pair --device <上面的 UDID>')
    print('     看到 available (paired) 就成了。刚插上的设备不会自动配对，第一次必须人工信任一次。')
PY
  else
    say "devicectl 没给出结果，退回 xctrace（拿不到开发者模式状态）："
    xcrun xctrace list devices 2>/dev/null | sed -n '/^== Devices/,/^== Simulators ==/p'
  fi
  rm -f "$DEVJSON"
  exit 0
fi

# --list-devices：只报告，不打包
if [ "$LIST_ONLY" = "1" ]; then
  say "=== 本机已安装的描述文件与其授权设备 ==="
  found=0
  while IFS= read -r p; do
    found=1
    # 注意：PlistBuddy 的层级分隔符是 `:` 而不是 `.`（用 `.` 会被当成键名的一部分，
    # 于是安静地取到空值 —— 这一处已经踩过一次）
    gta="$(pp_field "$p" Entitlements:get-task-allow)"
    [ "$gta" = "true" ] && kind="开发签名（设备要开开发者模式）" || kind="ad hoc / 分发签名"
    say ""
    say "  描述文件：$(pp_field "$p" Name)"
    say "  适用 App：$(pp_field "$p" Entitlements:application-identifier)"
    say "  类型    ：$kind"
    say "  到期    ：$(pp_field "$p" ExpirationDate)"
    say "  授权设备："
    d="$(devices_of_profile "$p")"
    if [ -n "$d" ]; then printf '%s\n' "$d" | sed 's/^/    /'; else say "    （无 —— 这类描述文件不绑设备）"; fi
  done < <(all_profiles)
  [ "$found" = "1" ] || say "  （一个都没有）"
  say ""
  say "  说明：$BUNDLE_ID 的 ad hoc 包需要一份适用于该 App、且包含目标设备的描述文件。"
  say "        上面若没有，就得到 developer.apple.com 新建（运行 $0 --adhoc 会打印步骤）。"
  exit 0
fi

if [ -z "$TEAM_ID" ]; then
  fail "拿不到团队 ID。请设置 TEAM_ID 环境变量，或检查 $ADHOC_PLIST 里的 teamID。"
fi

# ad hoc 模式的前置检查：描述文件必须存在，否则会走到一个很难懂的错误
if [ "$MODE" = "adhoc" ]; then
  if [ -z "$PROFILE_NAME" ]; then
    say "================================================================"
    say " ad hoc 打包还差一份描述文件"
    say "================================================================"
    say ""
    say "ad hoc 包必须用「显式 App ID 的 Ad Hoc 描述文件」签名。"
    say "现在本机没有，而且 Xcode 里没有登录开发者账号，脚本无法代你生成。"
    say ""
    say "去 developer.apple.com 做三件事（都很短）："
    say ""
    say "  1) Devices  ->  +  ->  粘贴 iPad 的 UDID（拿 UDID 的方法见下）"
    say "  2) Identifiers -> + -> App IDs -> App"
    say "     填 $BUNDLE_ID"
    say "     （已存在就跳过；如果 portal 提供通配 App ID，直接选它更省事，"
    say "       一份描述文件以后所有 App 都能用）"
    say "  3) Profiles -> + -> Ad Hoc -> 选上面那个 App ID"
    say "     -> 选 Apple Distribution 证书 -> 勾上要装的设备 -> Generate -> Download"
    say ""
    say "  下载到的 .mobileprovision 双击安装，或放进："
    say "     ~/Library/MobileDevice/Provisioning Profiles/"
    say ""
  say "  下载到的 .mobileprovision 双击安装即可，不用手工改配置 ——"
  say "  脚本会自己在 ~/Library/MobileDevice/Provisioning Profiles/ 里认出它"
  say "  （认出条件：分发签名 + 带设备名单 + App 匹配 $BUNDLE_ID 或通配 ${TEAM_ID}.*）。"
  say "  装好之后直接重跑这个脚本就行。"
  say ""
    say "  拿 UDID：iPad 连上电脑后在「访达」左侧选中设备，点设备名下方那行"
    say "  信息循环切换，切到「序列号」时点一下会变成 UDID，右键拷贝。"
    say "  或者装个「Apple Configurator」/「iMazing」读。"
    say ""
    say "  想先看现在有哪些设备已授权："
    say "     $0 --list-devices"
    say ""
    say "  急着先装上试试，可以走开发签名（不需要 Ad Hoc 描述文件）："
    say "     $0 --development"
    say "  代价是设备要开「开发者模式」（设置 -> 隐私与安全性 -> 开发者模式），"
    say "  而且只能装上授权名单里的设备。"
    say ""
    exit 1
  fi
  [ -n "$PROFILE_PATH" ] || fail "描述文件「${PROFILE_NAME}」没有安装到本机。下载后双击，或放进 ~/Library/MobileDevice/Provisioning Profiles/"
fi

# ---------- 生成工程 ----------

say "== 1/4 生成 Xcode 工程（TEAM_ID=${TEAM_ID}）=="
( cd "$IOS" && TEAM_ID="$TEAM_ID" xcodegen generate ) || fail "xcodegen generate 失败"

# ---------- 归档 ----------

ARCH="$ROOT/.workbuddy/archive"
mkdir -p "$ARCH"
DD="$ARCH/DerivedData"
rm -rf "$ARCH/$APP_NAME.xcarchive"

SIGN_ARGS=(-allowProvisioningUpdates CODE_SIGN_STYLE=Automatic)
if [ "$MODE" = "adhoc" ]; then
  # 手工签名：直接指定 Ad Hoc 描述文件，否则 xcodebuild 会挑到开发用的通配描述文件
  SIGN_ARGS=(CODE_SIGN_STYLE=Manual
             PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME"
             CODE_SIGN_IDENTITY="Apple Distribution"
             OTHER_CODE_SIGN_FLAGS="--keychain $HOME/Library/Keychains/login.keychain-db")
fi

say "== 2/4 归档（${MODE}）=="
xcodebuild -project "$IOS/XiangqiCoach.xcodeproj" -scheme XiangqiCoach \
  -destination 'generic/platform=iOS' -configuration Release \
  -archivePath "$ARCH/$APP_NAME.xcarchive" -derivedDataPath "$DD" \
  "${SIGN_ARGS[@]}" archive 2>&1 | tail -25 \
  | grep -E "error|warning: |ARCHIVE|Signing Identity|Provisioning Profile" || true
[ -d "$ARCH/$APP_NAME.xcarchive" ] || fail "没有产出 .xcarchive，归档失败"

# ---------- 导出 ----------

EO="$ADHOC_PLIST"
if [ "$MODE" = "development" ]; then
  mkdir -p "$OUT"
  EO="$OUT/exportOptions-development.plist"
  cat > "$EO" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>debugging</string>
	<key>signingStyle</key><string>automatic</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>compileBitcode</key><false/>
</dict>
</plist>
PLIST
else
  # ad hoc：导出配置现场生成，**显式指定描述文件**。
  #
  # 这里必须用 manual 签名。用 automatic 时 xcodebuild 会去 Apple 服务器
  # 解析/创建描述文件，本机没登录账号就会报 "No Accounts" 直接失败 ——
  # 哪怕前面归档已经用同一份描述文件成功签名了也不行
  # （实测踩过：ARCHIVE SUCCEEDED 之后 EXPORT FAILED，很能误导人）。
  #
  # 生成到单独文件，不覆盖 exportOptions-adhoc.plist —— 那是手写的配置，
  # 脚本只从它读 teamID（也可以在里面固定描述文件名）。
  mkdir -p "$OUT"
  EO="$OUT/exportOptions-adhoc.generated.plist"
  cat > "$EO" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>release-testing</string>
	<key>signingStyle</key><string>manual</string>
	<key>teamID</key><string>${TEAM_ID}</string>
	<key>compileBitcode</key><false/>
	<key>stripSwiftSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>provisioningProfiles</key>
	<dict>
		<key>${BUNDLE_ID}</key><string>${EXPORT_PROFILE_KEY}</string>
	</dict>
</dict>
</plist>
PLIST
  say "  导出指定的描述文件：${PROFILE_NAME}（UUID ${PROFILE_UUID:-未知}）"
fi

say "== 3/4 导出 IPA =="
EX="$ARCH/export"
rm -rf "$EX"
xcodebuild -exportArchive -archivePath "$ARCH/$APP_NAME.xcarchive" \
  -exportOptionsPlist "$EO" -exportPath "$EX" -allowProvisioningUpdates 2>&1 | tail -20 \
  | grep -E "error|EXPORT|Exported" || true

IPA_SRC="$(find "$EX" -maxdepth 1 -name '*.ipa' | head -1)"
[ -n "$IPA_SRC" ] || fail "没有产出 .ipa，导出失败"

VER="$(grep -E '^ *MARKETING_VERSION' "$IOS/project.yml" | head -1 | sed 's/.*: *"\{0,1\}//; s/"\{0,1\} *$//')"
IPA_DST="$OUT/${APP_NAME}-v${VER}-$( [ "$MODE" = "adhoc" ] && echo adhoc || echo dev ).ipa"
cp "$IPA_SRC" "$IPA_DST"

# ---------- 校验 ----------

say "== 4/4 校验 =="
PP="$(profile_of_ipa "$IPA_DST")" || fail "读不出 IPA 里的描述文件"
PNAME="$(plutil -extract Name raw "$PP" 2>/dev/null)"
PUUID="$(plutil -extract UUID raw "$PP" 2>/dev/null)"
PAID="$(plutil -extract Entitlements.application-identifier raw "$PP" 2>/dev/null)"
PEXP="$(plutil -extract ExpirationDate raw "$PP" 2>/dev/null)"
say "  描述文件：$PNAME"
say "  UUID    ：$PUUID"
say "  适用 App：$PAID"
say "  到期    ：$PEXP"
say "  体积    ：$(du -h "$IPA_DST" | cut -f1)"

# 强校验：IPA 里嵌的必须是**我们选中的那一份**。
# 名字相同、UUID 不同时，Xcode 完全可能挑到本机另一份同名的旧描述文件 ——
# 现场表现是「归档导出都成功、装到设备上才报 0xe8008012」。
if [ "$MODE" = "adhoc" ] && [ -n "$PROFILE_UUID" ] && [ "$PUUID" != "$PROFILE_UUID" ]; then
  say "  ❌ IPA 里嵌的不是选中的那份描述文件！"
  say "     选中：${PROFILE_UUID}（$(pp_field "$PROFILE_PATH" Name)）"
  say "     实嵌：${PUUID}（${PNAME}）"
  say "     多半是本机还有一份**同名**的旧描述文件被 Xcode 挑走了。"
  say "     解决：把旧的删掉，或给新的一份改名。查一下有哪些：$0 --list-devices"
  exit 1
fi

DEVS="$(devices_in_plist "$PP")"
N="$(printf '%s\n' "$DEVS" | grep -c . || true)"
say "  授权设备：$N 台"
printf '%s\n' "$DEVS" | sed 's/^/    /'

say ""
if [ -n "$WANT_UDID" ]; then
  if printf '%s\n' "$DEVS" | grep -qix "$WANT_UDID"; then
    say "  ✅ 目标设备 $WANT_UDID 在授权名单里，可以安装"
  else
    say "  ❌ 目标设备 $WANT_UDID 不在授权名单里 —— 装上去会失败！"
    say "     需要去 developer.apple.com 把这台设备加进 Devices，"
    say "     然后重新生成描述文件并重新下载安装。"
    exit 1
  fi
fi

say ""
say "产物：$IPA_DST"

# 可选：直接装到连着的设备上
if [ -n "$INSTALL_TO" ]; then
  say ""
  say "== 安装到设备 ${INSTALL_TO} =="
  TMPAPP="$(mktemp -d)"
  unzip -qo "$IPA_DST" -d "$TMPAPP" || fail "解包 IPA 失败"
  APPB="$(find "$TMPAPP/Payload" -maxdepth 1 -name '*.app' | head -1)"
  [ -n "$APPB" ] || fail "IPA 里没有找到 .app"
  # 走数据线安装要求设备打开「开发者模式」，与签名方式无关：
  # 实测 ad-hoc 签名的包同样会被这句话拦住（Developer Mode is disabled）。
  INSTALL_LOG="$(mktemp -t xqinstall)"
  if ! xcrun devicectl device install app --device "$INSTALL_TO" "$APPB" 2>&1 | tee "$INSTALL_LOG"; then
    rm -rf "$TMPAPP"
    say ""
    if grep -q "must be paired before it can be connected" "$INSTALL_LOG"; then
      fail "设备还没和这台 Mac 配对（RemotePairingError 2）。先跑这一步，再重试安装：

       xcrun devicectl manage pair --device ${INSTALL_TO}

     跑完**在设备上点「信任此电脑」并输入锁屏密码**，看到 available (paired) 就成了。
     （刚插上的设备不会自动配对；第一次必须人工信任一次。）"
    elif grep -q "Developer Mode is disabled" "$INSTALL_LOG"; then
      fail "设备没开「开发者模式」。设置 -> 隐私与安全性 -> 开发者模式 -> 打开，然后重启设备。
     （ad-hoc 签名也绕不过这一关 —— 除非改走 OTA / Apple Configurator）"
    elif grep -q "cannot be installed on this device" "$INSTALL_LOG"; then
      fail "描述文件里没有这台设备（错误码 0xe8008012）。
     去 developer.apple.com 做两步：
       1) Devices -> + 把它的硬件 UDID 加进去
       2) Profiles 里重新生成那份 ad-hoc 描述文件、下载、双击安装
     查当前哪些设备已授权：$0 --list-devices"
    else
      fail "安装失败，完整输出见 $INSTALL_LOG"
    fi
  fi
  rm -f "$INSTALL_LOG"
  say ""
  say "  装完了，启动一次确认不是装上就崩："
  xcrun devicectl device process launch --device "$INSTALL_TO" "$BUNDLE_ID" || \
    say "  （启动命令没成功，手动在设备上点开确认一下）"
  rm -rf "$TMPAPP"
fi

say ""
say "怎么装到 iPad 上（三选一）："
say "  1) 用「Apple Configurator」（App Store 免费）连着 iPad 拖进去"
say "  2) 把 ipa 拖到「访达」左侧的 iPad 上（需要 iPad 信任这台电脑）"
say "  3) 传到 iPad 上用「文件」App 打开（需要 iPadOS 支持，通常会转到设置里安装）"
if [ "$MODE" = "development" ]; then
  say ""
  say "  ⚠️ 这是开发签名，iPad 上要先打开「设置 -> 隐私与安全性 -> 开发者模式」，"
  say "     打开后需要重启设备。"
fi
