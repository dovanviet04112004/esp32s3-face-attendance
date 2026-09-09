#include "app_config.h"
#include "bsp_board.h"
#include "drv_ioexp.h"
#include "unity.h"

TEST_CASE("init answers at the planned address and refuses a second time", "[drv_ioexp]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_board_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_ioexp_init());
}

TEST_CASE("a pin past P7 is refused", "[drv_ioexp]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_ioexp_set(8, true));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_ioexp_set(255, false));
}

TEST_CASE("changing one line leaves the other seven where they stood", "[drv_ioexp]")
{
    // The chip takes all eight lines in one byte, so this is the invariant the
    // shadow register exists to hold.
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_AUDIO_SD, false));
    uint8_t port = 0;
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_read(&port));
    TEST_ASSERT_BIT_LOW(APP_IOEXP_P_AUDIO_SD, port);
    TEST_ASSERT_BIT_HIGH(APP_IOEXP_P_TOUCH_RST, port);
    TEST_ASSERT_BIT_HIGH(APP_IOEXP_P_TOF_XSHUT, port);

    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_TOF_XSHUT, false));
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_read(&port));
    TEST_ASSERT_BIT_LOW(APP_IOEXP_P_AUDIO_SD, port);
    TEST_ASSERT_BIT_LOW(APP_IOEXP_P_TOF_XSHUT, port);
    TEST_ASSERT_BIT_HIGH(APP_IOEXP_P_TOUCH_RST, port);

    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_TOF_XSHUT, true));
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_AUDIO_SD, true));
}

TEST_CASE("read rejects a null destination", "[drv_ioexp]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_ioexp_read(NULL));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
