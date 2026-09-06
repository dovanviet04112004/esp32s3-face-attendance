/** Error and handle conventions every component in this project shares.
 *  @ctx any | non-blocking
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Return from a call that must not fail during boot, logging the tag first. */
#define APP_RETURN_ON_ERR(expr, tag, msg)                     \
    do {                                                      \
        esp_err_t err_rc_ = (expr);                           \
        if (err_rc_ != ESP_OK) {                              \
            ESP_LOGE(tag, "%s: %s", msg, esp_err_to_name(err_rc_)); \
            return err_rc_;                                   \
        }                                                     \
    } while (0)

#ifdef __cplusplus
}
#endif
