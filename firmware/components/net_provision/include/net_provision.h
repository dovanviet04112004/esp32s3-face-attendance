/** A kiosk fetching and checking its own ticket over HTTPS (KEHOACH 7.3).
 *  @ctx task | runs on ota_task, the one task that holds an HTTPS session (KEHOACH 5.2)
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    NET_PROVISION_GRANTED = 0,            // the ticket stands, or is now in NVS
    NET_PROVISION_WAITING,                // 202: nobody has approved it yet
    NET_PROVISION_REFUSED,                // 401: batch token or ticket rejected
    NET_PROVISION_UNREACHABLE,            // no answer, 429 or 5xx
    NET_PROVISION_DISABLED,               // this build carries no batch token
} net_provision_answer_t;

/** Ask to be let in, once; a 200 leaves device/jwt and device/jwt_exp in NVS.
 *  @ctx task | blocking, one HTTPS round trip | internal-RAM stack: it writes NVS
 *  @param poll_s on WAITING, the seconds the server asks it to wait; 0 when it named none
 */
net_provision_answer_t net_provision_register(uint32_t *poll_s);

/** Ask whether the held ticket still stands, so a broker refusal is not taken on trust.
 *  @ctx task | blocking, one HTTPS round trip
 *  @ret GRANTED it stands | REFUSED api says it is dead | UNREACHABLE api did not say
 */
net_provision_answer_t net_provision_check(void);

/** Trade the held ticket for a fresh one; the old one stays good until the new is used.
 *  @ctx task | blocking, one HTTPS round trip | internal-RAM stack: it writes NVS
 *  @ret GRANTED new ticket in NVS | REFUSED api says it is dead | UNREACHABLE old one kept
 */
net_provision_answer_t net_provision_renew(void);

/** The exp of the ticket in NVS, as net_provision_ticket_exp read it when it landed.
 *  @ctx task | blocking | reads NVS | exp in epoch seconds
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND no ticket or no exp kept
 */
esp_err_t net_provision_held_exp(uint32_t *exp);

/** Whether a ticket expiring at exp is inside the renewal window (KEHOACH 7.3).
 *  @ctx any | non-blocking | now_ms from a clock NTP has set, 0 when there is none
 */
bool net_provision_renew_due(uint32_t exp, int64_t now_ms);

/** The six-digit claim code of this registration, made and kept on first ask.
 *  @ctx task | blocking | writes NVS the first time | cap at least 7
 *  @ret ESP_OK | ESP_ERR_INVALID_SIZE | an NVS error
 */
esp_err_t net_provision_claim(char *out, size_t cap);

/** Drop the held ticket so the next ask registers from the start.
 *  @ctx task | blocking | writes NVS
 */
esp_err_t net_provision_forget(void);

/** Read the exp claim of a ticket without trusting the kiosk's own clock.
 *  @ctx any | non-blocking | exp in epoch seconds
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG not a JWT or no numeric exp
 */
esp_err_t net_provision_ticket_exp(const char *ticket, uint32_t *exp);

/** The pause ahead of ask number attempt, counted from 0 (KEHOACH 7.3).
 *  @ctx any | non-blocking | random: any 32 bits, esp_random() on the kiosk
 */
uint32_t net_provision_wait_ms(uint32_t attempt, uint32_t random);

/** The pause a pending kiosk takes at the pace a 202 named, jittered like wait_ms.
 *  @ctx any | non-blocking | poll_s held between the floor and the backoff ceiling
 */
uint32_t net_provision_poll_ms(uint32_t poll_s, uint32_t random);

#ifdef __cplusplus
}
#endif
