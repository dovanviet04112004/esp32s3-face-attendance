#include "drv_camera.h"

#include "app_config.h"
#include "app_err.h"
#include "esp_log.h"

static const char *TAG = "drv_camera";

#define CAM_LEDC_TIMER LEDC_TIMER_1
#define CAM_LEDC_CHANNEL LEDC_CHANNEL_1
// The preview holds one frame for most of a frame period while the panel
// drains, so two would leave the sensor nowhere to land the next one.
#define CAM_FB_COUNT 3
#define CAM_JPEG_QUALITY 12

#define METER_TARGET_GREEN 30
#define METER_DEADBAND 4
#define METER_SAMPLE_STEP 8
#define METER_BASE_GAIN 1
#define METER_MAX_GAIN 4
#define METER_DAMPING 4
#define METER_SETTLE_FRAMES 2
#define METER_SATURATED 58
#define METER_STARVED 3
#define VTS_REG 0x380E
#define VTS_MASK 0xFFFF
#define HZ5060_CTRL00_REG 0x3C00
#define HZ5060_CTRL01_REG 0x3C01
#define BAND_50HZ_BIT 0x04
#define BAND_MANUAL_BIT 0x80

static bool s_ready;
static int s_exposure;
static int s_exposure_max;
static int s_gain = METER_BASE_GAIN;
static int s_settle;
static int s_level;

static int centre_green(const camera_fb_t *frame)
{
    const int x0 = frame->width / 4;
    const int x1 = frame->width - x0;
    const int y0 = frame->height / 4;
    const int y1 = frame->height - y0;
    const uint16_t *pixels = (const uint16_t *)frame->buf;
    uint32_t sum = 0;
    int taken = 0;

    for (int y = y0; y < y1; y += METER_SAMPLE_STEP) {
        const uint16_t *row = pixels + (size_t)y * frame->width;
        for (int x = x0; x < x1; x += METER_SAMPLE_STEP) {
            // The DVP lands RGB565 high byte first, and green carries most of
            // the luminance, so its six bits stand in for brightness.
            sum += (uint32_t)((__builtin_bswap16(row[x]) >> 5) & 0x3F);
            taken++;
        }
    }
    return taken ? (int)(sum / (uint32_t)taken) : 0;
}

static esp_err_t pick_50hz_band(sensor_t *sensor)
{
    // Mains here is 50 Hz and auto-detect wanders under fluorescent light:
    // 0x3C01 bit 7 takes the band off auto, 0x3C00 bit 2 picks 50 over 60.
    sensor->set_reg(sensor, HZ5060_CTRL01_REG, BAND_MANUAL_BIT, BAND_MANUAL_BIT);
    sensor->set_reg(sensor, HZ5060_CTRL00_REG, BAND_50HZ_BIT, BAND_50HZ_BIT);
    const int mode = sensor->get_reg(sensor, HZ5060_CTRL01_REG, BAND_MANUAL_BIT);
    const int band = sensor->get_reg(sensor, HZ5060_CTRL00_REG, BAND_50HZ_BIT);
    if (mode != BAND_MANUAL_BIT || band != BAND_50HZ_BIT) {
        ESP_LOGE(TAG, "band filter refused the write: mode %d band %d", mode, band);
        return ESP_ERR_INVALID_RESPONSE;
    }
    return ESP_OK;
}

static esp_err_t hold_exposure_still(sensor_t *sensor)
{
    // The sensor's own metering reads the whole scene, so a bright wall behind
    // a face drags the face into shadow (KEHOACH 2.1).
    sensor->set_exposure_ctrl(sensor, 0);
    sensor->set_gain_ctrl(sensor, 0);
    sensor->set_agc_gain(sensor, METER_BASE_GAIN);
    s_exposure_max = sensor->get_reg(sensor, VTS_REG, VTS_MASK);
    if (s_exposure_max <= 0) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    s_exposure = s_exposure_max / 2;
    sensor->set_aec_value(sensor, s_exposure);
    return ESP_OK;
}

esp_err_t drv_camera_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const camera_config_t cfg = {
        .pin_pwdn = APP_CAM_PWDN_GPIO,
        .pin_reset = APP_CAM_RESET_GPIO,
        .pin_xclk = APP_CAM_XCLK_GPIO,
        .pin_sccb_sda = APP_CAM_SIOD_GPIO,
        .pin_sccb_scl = APP_CAM_SIOC_GPIO,
        .pin_d7 = APP_CAM_D7_GPIO,
        .pin_d6 = APP_CAM_D6_GPIO,
        .pin_d5 = APP_CAM_D5_GPIO,
        .pin_d4 = APP_CAM_D4_GPIO,
        .pin_d3 = APP_CAM_D3_GPIO,
        .pin_d2 = APP_CAM_D2_GPIO,
        .pin_d1 = APP_CAM_D1_GPIO,
        .pin_d0 = APP_CAM_D0_GPIO,
        .pin_vsync = APP_CAM_VSYNC_GPIO,
        .pin_href = APP_CAM_HREF_GPIO,
        .pin_pclk = APP_CAM_PCLK_GPIO,
        .xclk_freq_hz = APP_CAM_XCLK_HZ,
        // Timer 0 and channel 0 drive the LCD backlight, so the sensor clock
        // takes the next pair rather than silently stealing that one.
        .ledc_timer = CAM_LEDC_TIMER,
        .ledc_channel = CAM_LEDC_CHANNEL,
        .pixel_format = PIXFORMAT_RGB565,
        .frame_size = FRAMESIZE_HVGA,
        .jpeg_quality = CAM_JPEG_QUALITY,
        .fb_count = CAM_FB_COUNT,
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST,
    };
    APP_RETURN_ON_ERR(esp_camera_init(&cfg), TAG, "sensor init");

    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    // The module sits with the lens above the connector, so its own frame
    // arrives upside down, and a kiosk preview reads as a mirror (KEHOACH 2.1).
    sensor->set_vflip(sensor, 1);
    sensor->set_hmirror(sensor, 1);
    APP_RETURN_ON_ERR(pick_50hz_band(sensor), TAG, "band filter");
    APP_RETURN_ON_ERR(hold_exposure_still(sensor), TAG, "manual exposure");
    s_ready = true;
    ESP_LOGI(TAG, "sensor 0x%04X up at %dx%d rgb565 in psram", sensor->id.PID, APP_CAM_H_RES,
             APP_CAM_V_RES);
    return ESP_OK;
}

camera_fb_t *drv_camera_grab(void)
{
    return esp_camera_fb_get();
}

void drv_camera_release(camera_fb_t *frame)
{
    if (frame != NULL) {
        esp_camera_fb_return(frame);
    }
}

esp_err_t drv_camera_expose(const camera_fb_t *frame)
{
    if (!s_ready || frame == NULL || frame->format != PIXFORMAT_RGB565) {
        return ESP_ERR_INVALID_STATE;
    }
    // The sensor takes a frame or two to act on a new exposure, so measuring
    // every frame would read a stale one and drive the loop into a flicker.
    if (s_settle > 0) {
        s_settle--;
        return ESP_OK;
    }
    const int level = centre_green(frame);
    s_level = level;
    const int error = METER_TARGET_GREEN - level;
    if (error > -METER_DEADBAND && error < METER_DEADBAND) {
        return ESP_OK;
    }
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    // Exposure and gain are one quantity here. Steering them separately makes
    // them fight: dropping gain darkens the frame, which asks for gain back.
    const int light = s_exposure * s_gain;
    int want;
    if (level >= METER_SATURATED) {
        want = light / 2;
    } else if (level <= METER_STARVED) {
        want = light * 2;
    } else {
        want = light * METER_TARGET_GREEN / level;
    }
    int next = light + (want - light) / METER_DAMPING;
    if (next == light) {
        next += want > light ? 1 : -1;
    }
    const int ceiling = s_exposure_max * METER_MAX_GAIN;
    next = next > ceiling ? ceiling : next;
    next = next < 1 ? 1 : next;
    if (next == light) {
        return ESP_OK;
    }
    // Exposure carries as much as it can and gain only takes the remainder,
    // because gain noise is what the anti-spoof branch misreads as skin.
    int gain = (next + s_exposure_max - 1) / s_exposure_max;
    gain = gain < METER_BASE_GAIN ? METER_BASE_GAIN : gain;
    const int exposure = next / gain;
    if (gain != s_gain) {
        sensor->set_agc_gain(sensor, gain);
        s_gain = gain;
    }
    if (exposure != s_exposure) {
        sensor->set_aec_value(sensor, exposure);
        s_exposure = exposure;
    }
    ESP_LOGD(TAG, "green %d -> exposure %d/%d gain %d", level, s_exposure, s_exposure_max, s_gain);
    s_settle = METER_SETTLE_FRAMES;
    return ESP_OK;
}


void drv_camera_exposure_state(int *level, int *exposure, int *gain)
{
    if (level != NULL) {
        *level = s_level;
    }
    if (exposure != NULL) {
        *exposure = s_exposure;
    }
    if (gain != NULL) {
        *gain = s_gain;
    }
}
