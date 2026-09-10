#include "app_boot.h"
#include "app_tasks.h"

#include "esp_err.h"

void app_main(void)
{
    ESP_ERROR_CHECK(app_boot());
    ESP_ERROR_CHECK(app_tasks_start());
}
