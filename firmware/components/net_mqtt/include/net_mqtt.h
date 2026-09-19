/** MQTT link to the broker: one client, the contract's topics, TLS.
 *  @ctx task | esp-mqtt owns the task this runs on (KEHOACH 5.2)
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "gen_topics.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Called when the link comes up or goes down, from the esp-mqtt task.
 *  @ctx task | non-blocking | do not publish from here
 */
typedef void (*net_mqtt_state_cb_t)(bool up, void *ctx);

/** Called for one inbound message on a down topic, from the esp-mqtt task.
 *  @ctx task | non-blocking | payload is only valid for the call
 */
typedef void (*net_mqtt_message_cb_t)(gen_topic_id_t topic, const char *payload, size_t len,
                                      void *ctx);

typedef struct {
    net_mqtt_state_cb_t on_state;         // may be NULL
    net_mqtt_message_cb_t on_message;     // may be NULL
    void *ctx;                            // handed back to both callbacks
} net_mqtt_config_t;

/** Connect and keep reconnecting, publishing the contract's online status.
 *  @ctx task | blocking | reads device/mqtt_uri, mqtt_user, mqtt_pass
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND with no broker configured | ESP_ERR_INVALID_ARG
 */
esp_err_t net_mqtt_start(const net_mqtt_config_t *config);

/** Send the will's offline status, disconnect and release the client.
 *  @ctx task | blocking
 */
esp_err_t net_mqtt_stop(void);

/** Whether the broker is connected right now.
 *  @ctx any | non-blocking
 */
bool net_mqtt_is_up(void);

/** Publish one payload and wait for the broker to acknowledge it.
 *  @ctx task | blocking | QoS and retain come from the contract, not the caller
 *  @param timeout_ms how long to wait for the ack; ignored at QoS 0
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE offline | ESP_ERR_TIMEOUT unacknowledged
 *       | ESP_ERR_INVALID_ARG no payload | ESP_ERR_INVALID_SIZE unknown topic
 */
esp_err_t net_mqtt_publish(gen_topic_id_t topic, const char *payload, size_t len,
                           uint32_t timeout_ms);

/** How many times the link has dropped since start.
 *  @ctx any | non-blocking | a rising count on a live wifi means the broker
 */
uint32_t net_mqtt_disconnects(void);

#ifdef __cplusplus
}
#endif
