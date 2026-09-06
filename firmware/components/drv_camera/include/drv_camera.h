/** The OV5640 on the DVP bus, handing out frames from PSRAM.
 *  @ctx task | blocking | frames belong to the driver until returned
 */
#pragma once

#include "esp_camera.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Start the sensor at QVGA RGB565 with its buffers in PSRAM.
 *  @ctx task | blocking | call once from app_main
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when the sensor does not answer on SCCB
 */
esp_err_t drv_camera_init(void);

/** Take the newest frame, which the caller must hand back.
 *  @ctx task | blocking until a frame is ready
 *  @ret NULL when no frame arrived; otherwise pair it with drv_camera_release
 */
camera_fb_t *drv_camera_grab(void);

/** Give a frame back to the pool.
 *  @ctx task | non-blocking | never called twice on one frame
 */
void drv_camera_release(camera_fb_t *frame);

/** Grab a few frames and log their size, format and rate.
 *  @ctx task | blocking for a second or so
 *  @ret ESP_OK once the run finishes, whatever it measured
 */
esp_err_t drv_camera_selftest(void);

#ifdef __cplusplus
}
#endif
