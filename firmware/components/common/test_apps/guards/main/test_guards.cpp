#include "lock_guard.hpp"
#include "unity.h"

TEST_CASE("LockGuard gives the mutex back at scope exit", "[common]")
{
    SemaphoreHandle_t mutex = xSemaphoreCreateMutex();
    {
        app::LockGuard guard(mutex, 100);
        TEST_ASSERT_TRUE(guard.held());
        TEST_ASSERT_EQUAL(pdFALSE, xSemaphoreTake(mutex, 0));
    }
    TEST_ASSERT_EQUAL(pdTRUE, xSemaphoreTake(mutex, 0));
    xSemaphoreGive(mutex);
    vSemaphoreDelete(mutex);
}

TEST_CASE("LockGuard reports a timeout instead of pretending it holds", "[common]")
{
    SemaphoreHandle_t mutex = xSemaphoreCreateMutex();
    TEST_ASSERT_EQUAL(pdTRUE, xSemaphoreTake(mutex, 0));
    {
        app::LockGuard guard(mutex, 10);
        TEST_ASSERT_FALSE(guard.held());
    }
    TEST_ASSERT_EQUAL(pdTRUE, uxSemaphoreGetCount(mutex) == 0);
    xSemaphoreGive(mutex);
    vSemaphoreDelete(mutex);
}

extern "C" void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
