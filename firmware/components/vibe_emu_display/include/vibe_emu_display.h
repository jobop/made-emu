#pragma once
/*
 * vibe_emu_display - esp-emu 虚拟显示（仅模拟器构建通过 EXTRA_COMPONENT_DIRS 挂载）
 * 组件自启动（constructor），无需在固件代码中显式调用。
 * 帧经 UART1 发出，宿主用 made-emu/tools/emu-viewer.mjs 查看；
 * 触摸由同一 UART1 的 "P x y" / "M x y" / "R" 行命令注入。
 */
