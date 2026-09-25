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

#define NET_MQTT_MESSAGE_CAP 4096         // past the largest down payload the contract allows

/** Called for one whole inbound message on a down topic, from the esp-mqtt task.
 *  @ctx task | holds the whole link while it runs: any wait short and bounded
 *       | payload is only valid for the call, at most NET_MQTT_MESSAGE_CAP bytes
 */
typedef void (*net_mqtt_message_cb_t)(gen_topic_id_t topic, const char *payload, size_t len,
                                      void *ctx);

/** Called when the broker refuses the login, which it also does while api is
 *  down (KEHOACH 7.4); esp-mqtt keeps dialling after it returns.
 *  @ctx task | non-blocking | from the esp-mqtt task
 */
typedef void (*net_mqtt_refused_cb_t)(void *ctx);

typedef struct {
    net_mqtt_state_cb_t on_state;         // may be NULL
    net_mqtt_message_cb_t on_message;     // may be NULL
    net_mqtt_refused_cb_t on_refused;     // may be NULL
    void *ctx;                            // handed back to every callback
} net_mqtt_config_t;

/** Connect and keep reconnecting, publishing the contract's online status.
 *  Logs in as mqtt_user or the deviceId, with mqtt_pass or the ticket.
 *  @ctx task | blocking | reads device/mqtt_uri, mqtt_user, mqtt_pass, jwt
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND with no broker configured | ESP_ERR_INVALID_ARG
 */
esp_err_t net_mqtt_start(const net_mqtt_config_t *config);

typedef enum {
    NET_MQTT_LOGIN_NONE = 0,              // nothing to log in with yet
    NET_MQTT_LOGIN_OVERRIDE,              // device/mqtt_pass, a bench or self-hosted broker
    NET_MQTT_LOGIN_TICKET,                // device/jwt, the ticket of KEHOACH 7.3
} net_mqtt_login_t;

/** Which password net_mqtt_start would present, without starting anything.
 *  @ctx task | blocking | reads device/mqtt_pass, jwt
 */
net_mqtt_login_t net_mqtt_login(void);

/** Report the link down, wait out any sender, send the offline status and release the client.
 *  @ctx task | blocking, up to 15 s behind a stuck sender | not from the esp-mqtt task
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE with no client
 *       | ESP_ERR_TIMEOUT when a sender kept the link, which then stays up
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
