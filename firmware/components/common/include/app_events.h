/** What tasks say to each other, in the one file every layer may include.
 *  @ctx any | non-blocking | the tables of KEHOACH 5.3 in C
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** The edge tof_task reports when the distance crosses vision.present_mm. */
typedef enum {
    APP_PRESENCE_OFF = 0,
    APP_PRESENCE_ON = 1,
} app_presence_t;

/** One per sound file in the assets partition (KEHOACH 6.2.8). */
typedef enum {
    APP_SOUND_OK = 0,
    APP_SOUND_DENIED,
    APP_SOUND_SPOOF,
    APP_SOUND_ENROLL,
    APP_SOUND_COUNT,
} app_sound_t;

/** What the screen says about whoever is standing there (KEHOACH 4.5.5h). */
typedef enum {
    APP_UI_IDLE = 0,
    APP_UI_SCANNING,
    APP_UI_GRANTED,
    APP_UI_DENIED,
    APP_UI_SPOOF,
    APP_UI_UNKNOWN,
} app_ui_verdict_t;

// The bits of eg_system, one per question a task is allowed to ask.
#define APP_EG_WIFI_OK 0x01u
#define APP_EG_MQTT_OK 0x02u
#define APP_EG_TIME_OK 0x04u
#define APP_EG_DB_LOADED 0x08u
#define APP_EG_AI_READY 0x10u
#define APP_EG_OTA_RUNNING 0x20u
#define APP_EG_PRESENT 0x40u

#ifdef __cplusplus
}
#endif
