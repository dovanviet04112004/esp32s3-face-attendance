#include "net_mqtt.h"
#include "uplink.hpp"

namespace uplink {

bool MqttLink::up() const noexcept
{
    return net_mqtt_is_up();
}

esp_err_t MqttLink::send(const char *payload, size_t len, uint32_t timeout_ms) noexcept
{
    // The contract puts attendance at QoS 1, so this returns on the puback.
    return net_mqtt_publish(GEN_TOPIC_ATTENDANCE, payload, len, timeout_ms);
}

}  // namespace uplink
