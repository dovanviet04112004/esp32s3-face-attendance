/** A kiosk fetching and checking its own ticket over HTTPS (KEHOACH 7.3).
 *  @ctx task | runs on ota_task, the one task that holds an HTTPS session (KEHOACH 5.2)
 */
#pragma once

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
 */
net_provision_answer_t net_provision_register(void);

/** Ask whether the held ticket still stands, so a broker refusal is not taken on trust.
 *  @ctx task | blocking, one HTTPS round trip
 *  @ret GRANTED it stands | REFUSED api says it is dead | UNREACHABLE api did not say
 */
net_provision_answer_t net_provision_check(void);

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

#ifdef __cplusplus
}
#endif
