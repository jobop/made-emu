idf_component_register(
    SRCS "vibe_emu_display.cpp"
    INCLUDE_DIRS "include"
    REQUIRES driver lvgl esp_lvgl_adapter
    # 组件自启动（constructor），无人显式引用，必须整档链接
    WHOLE_ARCHIVE
)

# emu 构建专用：新工具链（gcc 14.2）把 managed 组件（mcp-c-sdk 等）的
# stringop-truncation 警告升级成错误，emu 侧全局降回警告，不改 made。
idf_build_set_property(COMPILE_OPTIONS "-Wno-error=stringop-truncation" APPEND)

