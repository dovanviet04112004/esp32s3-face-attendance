#include "app_boot.h"
#include "app_console.h"
#include "app_tasks.h"

#include "esp_err.h"

void app_main(void)
{
    ESP_ERROR_CHECK(app_boot());
    ESP_ERROR_CHECK(app_tasks_start());
    // A prod build compiles the console out and returns ESP_ERR_NOT_SUPPORTED.
    app_console_start();
}
