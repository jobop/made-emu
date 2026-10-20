#!/bin/sh
# 运行 made emu：esp-emu + 虚拟显示
#   终端1: ./run-emu.sh          （真固件 + 真 WiFi NAT）
#   终端2: node tools/emu-viewer.mjs serve
#   浏览器: http://localhost:8080
#
# 可选参数透传给 esp-emu，如 ./run-emu.sh --wifi-ssid home --wifi-password 12345678
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
EMU_BIN="$HERE/bin/esp-emu"
FW="${MADE_EMU_FW:-/Users/myidd007/My project/made/made/build-emu/merged-binary.bin}"

if [ ! -x "$EMU_BIN" ]; then
    echo "error: $EMU_BIN not found (先运行 install.sh 或下载 release)" >&2
    exit 1
fi
if [ ! -f "$FW" ]; then
    echo "error: firmware not found: $FW (先运行 firmware/build-emu.sh)" >&2
    exit 1
fi

exec "$EMU_BIN" \
    --chip esp32s3 \
    --firmware "$FW" \
    --psram-size 8M \
    --uart1-tcp 127.0.0.1:5556 \
    "$@"
