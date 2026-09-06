/** The OV5640 on the DVP bus, handing out frames from PSRAM.
 *  @ctx task | blocking | frames belong to the driver until returned
 */
#pragma once

#include "esp_camera.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Start the sensor at HVGA RGB565 with its buffers in PSRAM.
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

/** Hold the middle of the frame at a steady brightness, one step per frame.
 *  @ctx task | blocking on SCCB | call while the frame is still held
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE while the sensor is down
 */
esp_err_t drv_camera_expose(const camera_fb_t *frame);

/** What the exposure loop last measured and where it put the two controls.
 *  @ctx any | non-blocking | brightness runs 0 to 63
 */
void drv_camera_exposure_state(int *level, int *exposure, int *gain);

#ifdef __cplusplus
}
#endif
