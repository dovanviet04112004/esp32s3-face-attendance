#include "lock_guard.hpp"
#include "queue.hpp"
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

TEST_CASE("Queue carries its element type and counts what waits", "[common]")
{
    struct Sample {
        int id;
        float score;
    };
    app::Queue<Sample, 4> queue;
    TEST_ASSERT_TRUE(queue.valid());
    TEST_ASSERT_EQUAL(0, queue.waiting());

    TEST_ASSERT_TRUE(queue.send({7, 0.5f}, 10));
    TEST_ASSERT_EQUAL(1, queue.waiting());

    Sample got{};
    TEST_ASSERT_TRUE(queue.receive(got, 10));
    TEST_ASSERT_EQUAL(7, got.id);
    TEST_ASSERT_EQUAL_FLOAT(0.5f, got.score);
    TEST_ASSERT_EQUAL(0, queue.waiting());
}

TEST_CASE("Queue refuses a fifth item and times out rather than blocking", "[common]")
{
    app::Queue<int, 4> queue;
    for (int i = 0; i < 4; ++i) {
        TEST_ASSERT_TRUE(queue.send(i, 10));
    }
    TEST_ASSERT_FALSE(queue.send(99, 10));
    TEST_ASSERT_EQUAL(4, queue.waiting());
}

extern "C" void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
