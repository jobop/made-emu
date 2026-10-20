#!/bin/sh
# 构建 made 固件的 emu 变体（不改动 made 仓库任何文件）
#
# 产物：made/made/build-emu/merged_flash.bin
# 运行：made-emu/run-emu.sh
set -e

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # made-emu 根目录
MADE_DIR="${MADE_DIR:-/Users/myidd007/My project/made/made}"
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"

if [ ! -d "$IDF_PATH" ]; then
    echo "error: IDF_PATH not found at $IDF_PATH" >&2
    exit 1
fi

# WorkBuddy shim 环境清理（PYTHONPATH 会破坏 idf.py；managed python 3.13 找不到 IDF venv，
# 必须让系统 python 3.9 优先——与仓库现有 flash 工具的做法一致）
unset PYTHONPATH
export PATH="/usr/bin:$PATH"
. "$IDF_PATH/export.sh" >/dev/null

cd "$MADE_DIR"
# SDKCONFIG 隔离到 build-emu/；defaults 顺序：官方 defaults -> made 现有 sdkconfig（保留
# 长期 menuconfig 调出的字体等配置）-> emu 覆盖项。均只读，不写回 made。
idf.py -B build-emu \
    -D "SDKCONFIG=build-emu/sdkconfig" \
    -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig;$HERE/firmware/sdkconfig.emu" \
    -D "EXTRA_COMPONENT_DIRS=$HERE/firmware/components" \
    build merge-bin

echo
echo "OK: $MADE_DIR/build-emu/merged_flash.bin"
