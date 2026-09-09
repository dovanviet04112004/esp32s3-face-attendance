#include "drv_audio.h"

#include <string.h>

#include "app_config.h"
#include "app_err.h"
#include "driver/i2s_std.h"
#include "drv_ioexp.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "drv_audio";

#define DMA_DESC_NUM 6
#define DMA_FRAME_NUM 240
#define DMA_RING_SAMPLES (DMA_DESC_NUM * DMA_FRAME_NUM)
#define CHUNK_SAMPLES 256
#define WRITE_TIMEOUT_MS 1000
#define AMP_WAKE_MS 10

static i2s_chan_handle_t s_tx;
static uint8_t s_volume = DRV_AUDIO_VOLUME_MAX;
static int16_t s_chunk[CHUNK_SAMPLES];

static esp_err_t amp_awake(bool awake)
{
    return drv_ioexp_set(APP_IOEXP_P_AUDIO_SD, awake);
}

static esp_err_t push_chunk(size_t samples)
{
    size_t written = 0;
    return i2s_channel_write(s_tx, s_chunk, samples * sizeof(int16_t), &written, WRITE_TIMEOUT_MS);
}

static esp_err_t push_scaled(const int16_t *pcm, size_t samples)
{
    while (samples > 0) {
        const size_t n = samples < CHUNK_SAMPLES ? samples : CHUNK_SAMPLES;
        for (size_t i = 0; i < n; ++i) {
            s_chunk[i] = (int16_t)(((int32_t)pcm[i] * s_volume) / DRV_AUDIO_VOLUME_MAX);
        }
        APP_RETURN_ON_ERR(push_chunk(n), TAG, "write");
        pcm += n;
        samples -= n;
    }
    return ESP_OK;
}

static esp_err_t push_silence(size_t samples)
{
    memset(s_chunk, 0, sizeof(s_chunk));
    while (samples > 0) {
        const size_t n = samples < CHUNK_SAMPLES ? samples : CHUNK_SAMPLES;
        APP_RETURN_ON_ERR(push_chunk(n), TAG, "silence");
        samples -= n;
    }
    return ESP_OK;
}

static esp_err_t channel_up(void)
{
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    chan.dma_desc_num = DMA_DESC_NUM;
    chan.dma_frame_num = DMA_FRAME_NUM;
    // A starved ring replays its last contents unless the driver zeroes each buffer it has sent.
    chan.auto_clear_after_cb = true;
    APP_RETURN_ON_ERR(i2s_new_channel(&chan, &s_tx, NULL), TAG, "channel");
    const i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(DRV_AUDIO_SAMPLE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = APP_AUDIO_BCLK_GPIO,
            .ws = APP_AUDIO_LRC_GPIO,
            .dout = APP_AUDIO_DIN_GPIO,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    esp_err_t err = i2s_channel_init_std_mode(s_tx, &std);
    if (err == ESP_OK) {
        err = i2s_channel_enable(s_tx);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "std mode: %s", esp_err_to_name(err));
        i2s_del_channel(s_tx);
        s_tx = NULL;
    }
    return err;
}

esp_err_t drv_audio_init(void)
{
    if (s_tx != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    APP_RETURN_ON_ERR(amp_awake(false), TAG, "amp off");
    APP_RETURN_ON_ERR(channel_up(), TAG, "i2s");
    ESP_LOGI(TAG, "max98357a on bclk%d ws%d din%d, %d Hz 16-bit mono, sd on p%d", APP_AUDIO_BCLK_GPIO,
             APP_AUDIO_LRC_GPIO, APP_AUDIO_DIN_GPIO, DRV_AUDIO_SAMPLE_HZ, APP_IOEXP_P_AUDIO_SD);
    return ESP_OK;
}

esp_err_t drv_audio_set_volume(uint8_t percent)
{
    if (percent > DRV_AUDIO_VOLUME_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    s_volume = percent;
    return ESP_OK;
}

esp_err_t drv_audio_play_pcm(const int16_t *pcm, size_t samples)
{
    if (s_tx == NULL || pcm == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    APP_RETURN_ON_ERR(amp_awake(true), TAG, "amp on");
    vTaskDelay(pdMS_TO_TICKS(AMP_WAKE_MS));
    esp_err_t err = push_scaled(pcm, samples);
    if (err == ESP_OK) {
        // Whatever the ring holds when SD drops is lost, so it has to hold silence by then.
        err = push_silence(DMA_RING_SAMPLES);
    }
    const esp_err_t off = amp_awake(false);
    return err != ESP_OK ? err : off;
}
