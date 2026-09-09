/** The MAX98357A on I2S: a sink for 16 kHz, 16-bit mono PCM (KEHOACH 6.2.3).
 *  @ctx task | blocking | one caller at a time, plays take m_i2c for the amp's SD line
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DRV_AUDIO_SAMPLE_HZ 16000
#define DRV_AUDIO_VOLUME_MAX 100

/** Start the I2S clocks and hold the amp in shutdown until something plays.
 *  @ctx task | blocking | call after drv_ioexp_init
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE on a second call
 */
esp_err_t drv_audio_init(void);

/** Scale every sample of later plays: DRV_AUDIO_VOLUME_MAX is full scale, 0 is mute.
 *  @ctx any | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG above DRV_AUDIO_VOLUME_MAX
 */
esp_err_t drv_audio_set_volume(uint8_t percent);

/** Wake the amp, push the clip through, and shut the amp down again.
 *  @ctx task | blocking for the clip length plus about 100 ms | takes m_i2c
 *  @param samples count of int16 mono samples at DRV_AUDIO_SAMPLE_HZ
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init | ESP_ERR_TIMEOUT
 */
esp_err_t drv_audio_play_pcm(const int16_t *pcm, size_t samples);

#ifdef __cplusplus
}
#endif
