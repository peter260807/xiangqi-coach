#!/bin/bash
#
# 编译 Kotlin 版 UCI 前端，并生成对局台能直接驱动的启动脚本。
#
#   ./tools/uci/run.sh              # 编译 + 生成 tools/uci/build/xq-uci-kotlin
#
# 生成物（都在 .gitignore 里，随时可重新生成）：
#   android/tools/uci/build/install/uci-kotlin/    Gradle application 插件的产物
#   android/tools/uci/build/xq-uci-kotlin          一层包装：对局台用 `uci:` 指到它
#
# 为什么需要包装这一层：Gradle 生成的启动脚本在 android/ 里，而 tools/match.js
# 用 `spawn(bin)` 直接执行（**不经过 shell**），所以路径必须直接可执行、
# 且不能带参数。这里做一层 exec 转发，顺便把工作目录与 JVM 路径固定住。
#
# 编译需要 JDK 21（AGP/Kotlin 的上限），见 android/gradle.properties 的说明。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$HERE/build"
LAUNCHER="$OUT_DIR/xq-uci-kotlin"

GRADLEW="$ANDROID/gradlew"
if [ ! -x "$GRADLEW" ]; then
  echo "找不到 $GRADLEW" >&2
  exit 1
fi

echo "编译 uci-kotlin（Gradle installDist）…"
( cd "$ANDROID" && "$GRADLEW" --quiet :uci-kotlin:installDist )

INSTALLED="$ANDROID/tools/uci/build/install/uci-kotlin/bin/uci-kotlin"
if [ ! -x "$INSTALLED" ]; then
  echo "编译产物不存在：$INSTALLED" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
# 由 android/tools/uci/run.sh 生成，勿手改。
# 对局台（tools/match.js）用 \`uci:android/tools/uci/build/xq-uci-kotlin\` 指到这里。
#
# 两个细节：
#   * JAVA_HOME 显式指到 JDK 21 —— 引擎本身在 17/21 上都能跑，但固定住
#     可以让「同一份产物在别的机器上行为不同」这种问题少一个来源。
#   * exec 转发，让引擎进程直接占住这个 PID：对局台 quit 之后
#     shell 与 JVM 一起退出，不会留下孤儿进程。
export JAVA_HOME="\${JAVA_HOME:-$HOME/jdk21/Contents/Home}"
exec "$INSTALLED" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "已生成: $LAUNCHER"
echo
echo "对局台用法："
echo "  node tools/match.js --a uci:android/tools/uci/build/xq-uci-kotlin \\"
echo "                      --b uci:tools/uci/build/xq-uci --ms 300 --games 40"
