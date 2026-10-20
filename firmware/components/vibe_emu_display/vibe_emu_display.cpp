/*
 * vibe_emu_display - esp-emu 虚拟显示组件（仅模拟器构建挂载）
 *
 * made 固件零改动：照常走 BSP 显示初始化（模拟的 SPI 会吞掉面板写入，
 * 但 BSP 的锁/背光/esp_lv_adapter LVGL 任务全部真实工作）。
 * 本组件在默认 lv_display 出现后：
 *   1. 换掉 LVGL flush_cb：把每个刷新区域的 RGB565 像素经 UART1 发给宿主查看器；
 *   2. 注册一个由 UART1 下行命令喂的触摸 indev。
 *
 * 帧协议（固件 -> 宿主，二进制，小端）：
 *   magic[4]="EFRM" | u16 w | u16 h | u16 x1 | u16 y1 | u16 x2 | u16 y2(闭区间)
 *   | u32 seq | u32 len | len 字节 RGB565LE 像素
 *
 * 触摸协议（宿主 -> 固件，ASCII 行）：
 *   "P <x> <y>\n" 按下   "M <x> <y>\n" 移动   "R\n" 抬起
 */
#include <string.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "lvgl.h"
#include "esp_lv_adapter.h"

#define EMU_TAG "emu_disp"
#define EMU_UART       UART_NUM_1
#define EMU_UART_TXD   17
#define EMU_UART_RXD   18
#define EMU_UART_BAUD  2000000
#define EMU_RX_BUF     2048

static const char FRAME_MAGIC[4] = {'E', 'F', 'R', 'M'};

typedef struct __attribute__((packed)) {
    char     magic[4];
    uint16_t w, h;
    uint16_t x1, y1, x2, y2;
    uint32_t seq;
    uint32_t len;
} emu_frame_hdr_t;

static volatile uint32_t s_seq = 0;
static lv_display_t *s_disp = NULL;
static bool s_installed = false;

/* ---- 触摸状态（UART RX 任务写，LVGL indev 读） ---- */
typedef struct {
    bool pressed;
    int16_t x, y;
} emu_touch_state_t;

static volatile emu_touch_state_t s_touch = {false, 0, 0};

/* ---- UART1 初始化（帧出口 + 触摸入口） ---- */
static bool emu_uart_init(void)
{
    uart_config_t cfg = {
        .baud_rate = EMU_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    if (uart_param_config(EMU_UART, &cfg) != ESP_OK) return false;
    if (uart_set_pin(EMU_UART, EMU_UART_TXD, EMU_UART_RXD,
                     UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
    /* tx_buf=0：直写 FIFO；模拟器侧无客户端时 TX 被丢弃，不会阻塞 */
    if (uart_driver_install(EMU_UART, EMU_RX_BUF, 0, 0, NULL, 0) != ESP_OK) return false;
    return true;
}

/* ---- LVGL flush：发区域帧，随后立即 flush_ready ---- */
static void emu_flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    int16_t x1 = area->x1, y1 = area->y1, x2 = area->x2, y2 = area->y2;
    if (x2 < x1 || y2 < y1) {
        lv_display_flush_ready(disp);
        return;
    }
    uint32_t w = (uint32_t)(x2 - x1 + 1);
    uint32_t h = (uint32_t)(y2 - y1 + 1);
    uint32_t len = w * h * 2;

    emu_frame_hdr_t hdr;
    memcpy(hdr.magic, FRAME_MAGIC, 4);
    hdr.w = (uint16_t)lv_display_get_horizontal_resolution(disp);
    hdr.h = (uint16_t)lv_display_get_vertical_resolution(disp);
    hdr.x1 = (uint16_t)x1;
    hdr.y1 = (uint16_t)y1;
    hdr.x2 = (uint16_t)x2;
    hdr.y2 = (uint16_t)y2;
    hdr.seq = ++s_seq;
    hdr.len = len;

    uart_write_bytes(EMU_UART, (const char *)&hdr, sizeof(hdr));
    uart_write_bytes(EMU_UART, (const char *)px_map, len);
    uart_wait_tx_done(EMU_UART, pdMS_TO_TICKS(500));

    lv_display_flush_ready(disp);
}

/* ---- 触摸 indev ---- */
static int s_read_cb_logs = 0;
static bool s_last_pressed = false;
static volatile bool s_full_redraw = false;
static void emu_touch_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    (void)indev;
    emu_touch_state_t snap;
    unsigned base = 0;
    /* 简单快照：读两次一致才采用，避免撕裂 */
    do {
        snap.pressed = s_touch.pressed;
        snap.x = s_touch.x;
        snap.y = s_touch.y;
        if (++base > 4) break;
    } while (snap.pressed != s_touch.pressed ||
             snap.x != s_touch.x || snap.y != s_touch.y);

    if (s_read_cb_logs < 40 && (snap.pressed ? (s_read_cb_logs % 8 == 0 || s_read_cb_logs < 6)
                                             : (s_read_cb_logs < 2 || s_last_pressed))) {
        ESP_LOGI(EMU_TAG, "read_cb #%d pressed=%d x=%d y=%d",
                 s_read_cb_logs++, snap.pressed, snap.x, snap.y);
    } else {
        s_read_cb_logs++;
    }
    s_last_pressed = snap.pressed;

    if (s_full_redraw) {
        s_full_redraw = false;
        lv_obj_t *scr = lv_display_get_screen_active(indev ? lv_indev_get_display(indev) : s_disp);
        if (scr) lv_obj_invalidate(scr);
    }

    data->point.x = snap.x;
    data->point.y = snap.y;
    data->state = snap.pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

/* ---- UART RX 任务：解析宿主触摸命令行 ---- */
static void emu_rx_task(void *arg)
{
    (void)arg;
    char line[48];
    size_t used = 0;
    uint8_t byte;

    for (;;) {
        int n = uart_read_bytes(EMU_UART, &byte, 1, pdMS_TO_TICKS(200));
        if (n <= 0) continue;
        if (byte == '\r') continue;
        if (byte != '\n') {
            if (used < sizeof(line) - 1) line[used++] = (char)byte;
            continue;
        }
        line[used] = '\0';
        used = 0;
        int x = 0, y = 0;
        if (line[0] == 'P' && sscanf(line + 1, "%d %d", &x, &y) == 2) {
            ESP_LOGI(EMU_TAG, "rx P %d %d", x, y);
            s_touch.x = (int16_t)x;
            s_touch.y = (int16_t)y;
            s_touch.pressed = true;
        } else if (line[0] == 'M' && sscanf(line + 1, "%d %d", &x, &y) == 2) {
            if (s_touch.pressed) {
                s_touch.x = (int16_t)x;
                s_touch.y = (int16_t)y;
            }
        } else if (line[0] == 'R') {
            s_touch.pressed = false;
        } else if (line[0] == 'F') {
            /* 全屏重绘：LVGL 上下文里 invalidate（read_cb 中执行） */
            s_full_redraw = true;
        }
    }
}

/* ---- 屏幕事件探针：定位输入分发断点（仅 emu 诊断） ---- */
static int s_probe_logs = 0;
static void emu_probe_cb(lv_event_t *e)
{
    if (s_probe_logs < 10) {
        ESP_LOGI(EMU_TAG, "probe: code=%d obj=%p", (int)lv_event_get_code(e), (void *)lv_event_get_target(e));
        s_probe_logs++;
    }
}

/* ---- 安装钩子（等默认 display 出现） ---- */
static void emu_boot_task(void *arg)
{
    (void)arg;
    if (!emu_uart_init()) {
        ESP_LOGE(EMU_TAG, "UART1 init failed; emu display disabled");
        vTaskDelete(NULL);
        return;
    }
    xTaskCreate(emu_rx_task, "emu_rx", 3072, NULL, 5, NULL);

    lv_display_t *disp = NULL;
    while (disp == NULL) {
        disp = lv_display_get_default();
        if (disp == NULL) vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (esp_lv_adapter_lock(pdMS_TO_TICKS(1000)) != ESP_OK) {
        ESP_LOGE(EMU_TAG, "adapter lock timeout; emu display disabled");
        vTaskDelete(NULL);
        return;
    }
    if (lv_display_get_default() == disp && !s_installed) {
        lv_display_set_flush_cb(disp, emu_flush_cb);
        lv_indev_t *indev = lv_indev_create();
        if (indev) {
            lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
            lv_indev_set_read_cb(indev, emu_touch_read_cb);
            lv_indev_set_disp(indev, disp);
        }
        s_disp = disp;
        s_installed = true;
        lv_obj_t *scr = lv_display_get_screen_active(disp);
        lv_obj_add_event_cb(scr, emu_probe_cb, LV_EVENT_PRESSED, NULL);
        lv_obj_add_event_cb(scr, emu_probe_cb, LV_EVENT_PRESSING, NULL);
        lv_obj_add_event_cb(scr, emu_probe_cb, LV_EVENT_CLICKED, NULL);
        lv_obj_add_event_cb(scr, emu_probe_cb, LV_EVENT_GESTURE, NULL);
        ESP_LOGI(EMU_TAG, "hooked: disp=%p indev=%p scr=%p frames->UART1",
                 (void *)disp, (void *)indev, (void *)scr);
    }
    esp_lv_adapter_unlock();
    vTaskDelete(NULL);
}

/* 构造函数：系统启动早期拉起等待任务（init_array 会被链接脚本保留） */
__attribute__((constructor))
static void emu_display_ctor(void)
{
    xTaskCreate(emu_boot_task, "emu_boot", 4096, NULL, 4, NULL);
}
