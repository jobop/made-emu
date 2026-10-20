# made-emu

在 [esp-emu](https://github.com/espressif/esp-emulator)（Espressif 官方全系统模拟器）上跑 **made 真固件**：真实 WiFi（NAT 出宿主网卡）、真实 PSRAM/flash，同时把 LVGL 画面截到宿主浏览器里看，支持触摸交互与截图。

**made 仓库零改动**——模拟器侧全部逻辑在本工程。

## 原理

```
made 固件（真实镜像，未修改）
  └─ BSP 显示照常初始化（ST7789 SPI 写入被模拟器吞掉，但
     BSP 锁/背光/esp_lv_adapter 的 LVGL 任务全部正常工作）
      └─ vibe_emu_display 组件（仅 emu 构建挂载，constructor 自启）
           ├─ 换掉 LVGL flush_cb → 区域帧经 UART1 发出
           └─ 注册触摸 indev ← UART1 下行 "P x y"/"M x y"/"R" 行命令
esp-emu（预编译二进制，未修改）
  ├─ --uart1-tcp 127.0.0.1:5556  把 UART1 桥成 TCP
  ├─ WiFi SoftAP + user-mode NAT（macOS 零配置真联网）
  └─ --control-tcp（可选）：远程 reset / 擦写 flash
宿主（tools/emu-viewer.mjs，零依赖 node）
  ├─ serve：http://localhost:8080 实时画面 + 点击/拖动回传
  └─ shot：抓一帧存 PNG（对应旧 sim 的 --shot）
```

## 使用

```sh
# 1. 构建固件 emu 变体（首次全量编译较久；不改 made 的 sdkconfig）
./firmware/build-emu.sh
#    产物：/Users/myidd007/My project/made/made/build-emu/merged_flash.bin

# 2. 终端 1：跑模拟器
./run-emu.sh

# 3. 终端 2：起查看器
node tools/emu-viewer.mjs serve          # 打开 http://localhost:8080

# 或者只抓一帧
node tools/emu-viewer.mjs shot --out shot.png
```

WiFi：固件通过 sdkconfig 覆盖连接 esp-emu 内置 SoftAP（默认 `myssid`/`mypassword`，见 `firmware/sdkconfig.emu`），经 user-mode NAT 出宿主网络。改 AP 凭据：`./run-emu.sh --wifi-ssid xxx --wifi-password yyy` 并同步改 overlay。

## 帧协议（UART1）

固件 → 宿主（小端）：`"EFRM" | u16 w | u16 h | u16 x1 | u16 y1 | u16 x2 | u16 y2(闭区间) | u32 seq | u32 len | len×RGB565LE`

宿主 → 固件（ASCII 行）：`P <x> <y>` 按下、`M <x> <y>` 按住移动、`R` 抬起、`F` 请求全屏重绘（查看器连接建立时自动发送，shot 模式因此能拿到完整画面）。

## 已知边界

- 触摸探针（CST816S I2C）在模拟器上必然失败，2.8 屏 BSP 会容忍并继续（"Touch unavailable"）；真实触摸由我们的 indev 提供。
- esp-sr / Xiaozhi 音频栈若使用 S3 SIMD 而模拟器未实现，可能在启动音频时 panic——出现后需要在 emu 构建禁用对应功能。
- esp-emu 版本 0.49.0（`bin/esp-emu`），Beta。
