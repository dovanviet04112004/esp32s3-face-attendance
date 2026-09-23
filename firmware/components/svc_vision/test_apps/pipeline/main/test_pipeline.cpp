#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "unity.h"
#include "vision.hpp"

namespace {

constexpr int kFrameW = 480;
constexpr int kFrameH = 320;
constexpr float kBigFace = 150.0f;
constexpr float kSmallFace = 60.0f;
constexpr float kLiveScore = 0.9f;
constexpr float kSpoofScore = 0.1f;
constexpr float kMatchScore = 0.83f;
constexpr float kStrangerScore = 0.31f;
constexpr uint32_t kEmployee = 42;
constexpr int kRetryDetects = 3;

uint16_t s_pixels[4];
const ai_engine_frame_t kFrame = { s_pixels, kFrameW, kFrameH, true };

class FakeDetector final : public vision::IDetector {
public:
    int calls = 0;
    size_t count = 0;
    ai_engine_face_t faces[vision::kMaxFaces] = {};

    void one(float left, float top, float side) noexcept
    {
        count = 1;
        set(0, left, top, side);
    }

    void oblong(float left, float top, float width, float height) noexcept
    {
        count = 1;
        ai_engine_face_t &f = faces[0];
        f.box[0] = left;
        f.box[1] = top;
        f.box[2] = left + width;
        f.box[3] = top + height;
        f.score = 0.9f;
    }

    void set(size_t index, float left, float top, float side) noexcept
    {
        ai_engine_face_t &f = faces[index];
        f.box[0] = left;
        f.box[1] = top;
        f.box[2] = left + side;
        f.box[3] = top + side;
        for (int i = 0; i < 10; ++i) {
            f.landmarks[i] = (i % 2 == 0 ? left : top) + side / 2.0f;
        }
        f.score = 0.95f;
    }

    size_t detect(const ai_engine_frame_t &, float, ai_engine_face_t *out, size_t cap) noexcept override
    {
        ++calls;
        const size_t n = count < cap ? count : cap;
        for (size_t i = 0; i < n; ++i) {
            out[i] = faces[i];
        }
        return n;
    }
};

class FakeLiveness final : public vision::ILiveness {
public:
    bool present = true;
    float live = kLiveScore;
    int scores = 0;

    bool available() const noexcept override { return present; }
    esp_err_t score(const ai_engine_frame_t &, const float *, float *out) noexcept override
    {
        ++scores;
        *out = live;
        return ESP_OK;
    }
};

class FakeEmbedder final : public vision::IEmbedder {
public:
    int embeds = 0;

    esp_err_t embed(const ai_engine_frame_t &, const float *, int8_t *out, size_t cap_bytes,
                    float *scale) noexcept override
    {
        ++embeds;
        memset(out, 7, cap_bytes);
        *scale = 0.01f;
        return ESP_OK;
    }
};

class FakeMatcher final : public vision::IMatcher {
public:
    esp_err_t answer = ESP_OK;
    esp_err_t kept_answer = ESP_OK;
    float score = kMatchScore;
    int calls = 0;
    int keeps = 0;
    uint32_t kept_id = 0;
    uint16_t kept_idx = 0;

    esp_err_t best(const int8_t *, float, uint32_t *employee_id, float *out, char *name,
                   size_t name_cap) noexcept override
    {
        ++calls;
        *employee_id = kEmployee;
        *out = score;
        if (name != nullptr && name_cap > 0) {
            name[0] = '\0';
        }
        return answer;
    }

    esp_err_t keep(const int8_t *, float, uint32_t employee_id, uint16_t template_idx,
                   const char *) noexcept override
    {
        ++keeps;
        kept_id = employee_id;
        kept_idx = template_idx;
        return kept_answer;
    }
};

struct Rig {
    FakeDetector detector;
    FakeLiveness liveness;
    FakeEmbedder embedder;
    FakeMatcher matcher;
    vision::VisionPipeline pipeline{ detector, liveness, embedder, matcher };

    Rig()
    {
        const svc_vision_thresholds_t thresholds = { 0.5f, 0.5f, 0.6f, 113 };
        pipeline.configure(thresholds);
    }

    svc_vision_kind_t step() { return pipeline.step(kFrame).kind; }
};

}  // namespace

TEST_CASE("a face stable over two detects is verified in that step and reported once", "[svc_vision]")
{
    Rig rig;
    rig.detector.one(100.0f, 80.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(0, rig.liveness.scores);
    TEST_ASSERT_EQUAL(0, rig.embedder.embeds);
    const svc_vision_result_t result = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, result.kind);
    TEST_ASSERT_EQUAL(kEmployee, result.employee_id);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, kMatchScore, result.match_score);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, kLiveScore, result.live_score);
    TEST_ASSERT_EQUAL(2, rig.detector.calls);
    TEST_ASSERT_EQUAL(1, rig.liveness.scores);
    TEST_ASSERT_EQUAL(1, rig.embedder.embeds);
    TEST_ASSERT_EQUAL(1, rig.matcher.calls);
    for (int i = 0; i < 10; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    }
    TEST_ASSERT_EQUAL(1, rig.liveness.scores);
    TEST_ASSERT_EQUAL(12, rig.detector.calls);
}

TEST_CASE("a spoof stops before recognition, and the same face is retried later", "[svc_vision]")
{
    Rig rig;
    rig.liveness.live = kSpoofScore;
    rig.detector.one(100.0f, 80.0f, kBigFace);
    rig.step();
    const svc_vision_result_t result = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(SVC_VISION_SPOOF, result.kind);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, kSpoofScore, result.live_score);
    TEST_ASSERT_EQUAL(0, rig.embedder.embeds);
    for (int i = 0; i < kRetryDetects - 1; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
        TEST_ASSERT_EQUAL(1, rig.liveness.scores);
    }
    TEST_ASSERT_EQUAL(SVC_VISION_SPOOF, rig.step());
    TEST_ASSERT_EQUAL(2, rig.liveness.scores);
    TEST_ASSERT_EQUAL(0, rig.embedder.embeds);
}

TEST_CASE("no face is reported once, and a returning face starts over", "[svc_vision]")
{
    Rig rig;
    rig.detector.one(100.0f, 80.0f, kBigFace);
    rig.step();
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
    rig.detector.count = 0;
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(SVC_VISION_NO_FACE, rig.step());
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    rig.detector.one(100.0f, 80.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(1, rig.liveness.scores);
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
    TEST_ASSERT_EQUAL(2, rig.liveness.scores);
}

TEST_CASE("a face that jumps elsewhere is a new track and waits to settle again", "[svc_vision]")
{
    Rig rig;
    rig.detector.one(20.0f, 20.0f, kBigFace);
    rig.step();
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
    rig.detector.one(300.0f, 150.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(1, rig.liveness.scores);
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
    TEST_ASSERT_EQUAL(2, rig.liveness.scores);
}

TEST_CASE("a face hanging off the frame is reported once and never verified", "[svc_vision]")
{
    Rig rig;
    rig.detector.one(-20.0f, 100.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_FACE_OUT_OF_FRAME, rig.step());
    for (int i = 0; i < 5; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    }
    TEST_ASSERT_EQUAL(0, rig.liveness.scores);
    TEST_ASSERT_EQUAL(0, rig.embedder.embeds);
}

TEST_CASE("a tall face inside the frame still fails when its square is not", "[svc_vision]")
{
    Rig rig;
    rig.detector.oblong(390.0f, 100.0f, 80.0f, 150.0f);
    TEST_ASSERT_EQUAL(SVC_VISION_FACE_OUT_OF_FRAME, rig.step());
    TEST_ASSERT_EQUAL(0, rig.liveness.scores);
    rig.detector.oblong(200.0f, 100.0f, 80.0f, 150.0f);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
}

TEST_CASE("a small face is reported once and never verified", "[svc_vision]")
{
    Rig rig;
    rig.detector.one(200.0f, 120.0f, kSmallFace);
    TEST_ASSERT_EQUAL(SVC_VISION_FACE_SMALL, rig.step());
    for (int i = 0; i < 5; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    }
    TEST_ASSERT_EQUAL(0, rig.liveness.scores);
    TEST_ASSERT_EQUAL(0, rig.embedder.embeds);
}

TEST_CASE("without a spoof branch the chain skips liveness and says so", "[svc_vision]")
{
    Rig rig;
    rig.liveness.present = false;
    rig.detector.one(100.0f, 80.0f, kBigFace);
    rig.step();
    const svc_vision_result_t result = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, result.kind);
    TEST_ASSERT_TRUE(result.live_score < 0.0f);
    TEST_ASSERT_EQUAL(0, rig.liveness.scores);
    TEST_ASSERT_EQUAL(1, rig.embedder.embeds);
}

TEST_CASE("a stranger and an empty table both come back unknown", "[svc_vision]")
{
    Rig rig;
    rig.matcher.score = kStrangerScore;
    rig.detector.one(100.0f, 80.0f, kBigFace);
    rig.step();
    svc_vision_result_t result = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, result.kind);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, kStrangerScore, result.match_score);
    for (int i = 0; i < kRetryDetects - 1; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    }
    TEST_ASSERT_EQUAL(SVC_VISION_UNKNOWN, rig.step());

    Rig empty;
    empty.matcher.answer = ESP_ERR_NOT_FOUND;
    empty.detector.one(100.0f, 80.0f, kBigFace);
    empty.step();
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, empty.pipeline.step(kFrame).kind);
    for (int i = 0; i < kRetryDetects - 1; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, empty.step());
    }
    TEST_ASSERT_EQUAL(SVC_VISION_UNKNOWN, empty.step());
}

// An enrolled person's frames do fall under match_min (E8-T12), so a verdict on
// the first sample calls an employee a stranger and grants them a second later.
TEST_CASE("a face that falls short once is never called a stranger", "[svc_vision]")
{
    Rig rig;
    rig.matcher.score = kStrangerScore;
    rig.detector.one(100.0f, 80.0f, kBigFace);
    rig.step();
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.pipeline.step(kFrame).kind);
    rig.matcher.score = kMatchScore;
    for (int i = 0; i < kRetryDetects - 1; ++i) {
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    }
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
}

// The square is sized by the head and bounded by the short side of the frame, so
// a person standing off centre trips the geometry gate over and over.
TEST_CASE("a face that dips out of the square keeps its track and still answers", "[svc_vision]")
{
    Rig rig;
    rig.matcher.score = kStrangerScore;
    rig.detector.one(100.0f, 150.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    rig.detector.one(100.0f, 180.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_FACE_OUT_OF_FRAME, rig.step());
    rig.detector.one(100.0f, 150.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    TEST_ASSERT_EQUAL(SVC_VISION_UNKNOWN, rig.step());
}

TEST_CASE("a larger newcomer waits until the face being served has left", "[svc_vision]")
{
    Rig rig;
    rig.detector.one(20.0f, 20.0f, kBigFace);
    rig.step();
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, rig.step());
    // The newcomer stands closer, so its box is larger; the first face is still there.
    rig.detector.count = 2;
    rig.detector.set(0, 280.0f, 100.0f, kBigFace + 40.0f);
    rig.detector.set(1, 20.0f, 20.0f, kBigFace);
    for (int i = 0; i < 4; ++i) {
        const svc_vision_result_t result = rig.pipeline.step(kFrame);
        TEST_ASSERT_EQUAL(SVC_VISION_NONE, result.kind);
        TEST_ASSERT_FLOAT_WITHIN(0.001f, 20.0f, result.primary.box[0]);
        TEST_ASSERT_EQUAL(2, result.faces);
    }
    TEST_ASSERT_EQUAL(1, rig.liveness.scores);
    rig.detector.one(280.0f, 100.0f, kBigFace + 40.0f);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    const svc_vision_result_t served = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, served.kind);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 280.0f, served.primary.box[0]);
    TEST_ASSERT_EQUAL(2, rig.liveness.scores);
}

TEST_CASE("two faces of one size side by side do not swap the track", "[svc_vision]")
{
    Rig rig;
    rig.detector.count = 2;
    rig.detector.set(0, 20.0f, 60.0f, kBigFace);
    rig.detector.set(1, 300.0f, 60.0f, kBigFace);
    TEST_ASSERT_EQUAL(SVC_VISION_NONE, rig.step());
    // The detector lists them the other way round on the next frame.
    rig.detector.set(0, 300.0f, 60.0f, kBigFace);
    rig.detector.set(1, 20.0f, 60.0f, kBigFace);
    const svc_vision_result_t result = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(SVC_VISION_MATCH, result.kind);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 20.0f, result.primary.box[0]);
}

TEST_CASE("every face is reported up to the cap and the largest is followed", "[svc_vision]")
{
    Rig rig;
    rig.detector.count = 3;
    rig.detector.set(0, 10.0f, 10.0f, 120.0f);
    rig.detector.set(1, 300.0f, 100.0f, kBigFace);
    rig.detector.set(2, 200.0f, 200.0f, 90.0f);
    const svc_vision_result_t result = rig.pipeline.step(kFrame);
    TEST_ASSERT_EQUAL(3, result.faces);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 300.0f, result.primary.box[0]);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 10.0f, result.boxes[0].box[0]);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 200.0f, result.boxes[2].box[0]);
}

extern "C" void app_main(void)
{
    // The whole suite prints in a few ms, and the console drops whatever will
    // not fit the 64-byte usb fifo unless a driver stands behind it.
    usb_serial_jtag_driver_config_t console = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&console) == ESP_OK) {
        usb_serial_jtag_vfs_use_driver();
    }
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
