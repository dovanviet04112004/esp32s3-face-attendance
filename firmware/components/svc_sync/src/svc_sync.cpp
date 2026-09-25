#include "svc_sync.h"

#include "app_err.h"
#include "esp_log.h"
#include "sys_time.h"
#include "uplink.hpp"

namespace {

const char *TAG = "svc_sync";

uplink::LittleFsPersist s_store;
uplink::MqttLink s_link;
uplink::UplinkQueue s_queue(s_store, s_link);
bool s_ready = false;

}  // namespace

esp_err_t svc_sync_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    char device_id[STORAGE_DEVICE_ID_CAP] = {};
    APP_RETURN_ON_ERR(sys_storage_device_id(device_id, sizeof(device_id)), TAG, "device id");
    APP_RETURN_ON_ERR(s_queue.init(device_id), TAG, "queue");
    s_ready = true;
    return ESP_OK;
}

esp_err_t svc_sync_drain(bool wait_for_clock)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    uplink::BootClock clock;
    clock.boot = sys_storage_boot_count();
    clock.placed = sys_time_boot_at_ms(&clock.boot_at_ms) == ESP_OK;
    clock.wait = wait_for_clock;
    s_queue.set_clock(clock);
    return s_queue.drain(CONFIG_SYNC_BATCH_RECORDS, CONFIG_SYNC_ACK_TIMEOUT_MS);
}

bool svc_sync_pending(void)
{
    return s_ready && s_queue.pending();
}

svc_sync_stats_t svc_sync_stats(void)
{
    return s_ready ? s_queue.stats() : (svc_sync_stats_t){};
}
