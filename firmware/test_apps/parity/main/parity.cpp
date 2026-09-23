#include <dirent.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "sys_storage.h"
#include "svc_facedb.h"
#include "unity.h"

#include "antispoof/spoof_model.hpp"
#include "detection/detect_model.hpp"
#include "recognition/recog_model.hpp"
#include "tensor_view.hpp"

#define GOLD_ROOT "/lfs"
#define GOLD_MAGIC 0x444C4F47u
#define GOLD_VERSION 1
#define NAME_BYTES 32
#define MAX_DIMS 4
#define MAX_TENSORS 16
#define MAX_CASES 8
#define PATH_MAX_LEN 96
#define DTYPE_F32 0
#define DTYPE_I8 1
#define DTYPE_I32 2
#define DTYPE_U8 3
#define DTYPE_U16 4

#define DETECT_H 120
#define DETECT_W 160
#define SPOOF_SIDE 81
#define ALIGN_SIDE 113
#define EMBED_DIM 512
#define FACE_CAP 32
#define LEVELS 3
#define HEADS 9
#define TOLERANCE 1e-3f
#define ALIGN_LSB 2

namespace {

struct GoldTensor {
    char name[NAME_BYTES];
    uint32_t dtype;
    uint32_t ndim;
    uint32_t dims[MAX_DIMS];
    uint32_t nbytes;
    const uint8_t *data;
};

struct GoldCase {
    uint8_t *blob;
    GoldTensor tensors[MAX_TENSORS];
    size_t count;
};

void mount_once()
{
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
}

void free_case(GoldCase &gold)
{
    free(gold.blob);
    gold.blob = nullptr;
    gold.count = 0;
}

bool load_case(const char *path, GoldCase &gold)
{
    gold.blob = nullptr;
    gold.count = 0;
    FILE *handle = fopen(path, "rb");
    if (handle == nullptr) {
        return false;
    }
    fseek(handle, 0, SEEK_END);
    const long size = ftell(handle);
    fseek(handle, 0, SEEK_SET);
    gold.blob = static_cast<uint8_t *>(heap_caps_malloc(static_cast<size_t>(size), MALLOC_CAP_SPIRAM));
    const bool read = gold.blob != nullptr && fread(gold.blob, 1, static_cast<size_t>(size), handle) ==
                                                  static_cast<size_t>(size);
    fclose(handle);
    if (!read || size < 12) {
        free_case(gold);
        return false;
    }
    uint32_t header[3];
    memcpy(header, gold.blob, sizeof(header));
    if (header[0] != GOLD_MAGIC || header[1] != GOLD_VERSION || header[2] > MAX_TENSORS) {
        free_case(gold);
        return false;
    }
    size_t offset = sizeof(header);
    for (uint32_t i = 0; i < header[2]; ++i) {
        GoldTensor &at = gold.tensors[i];
        memcpy(at.name, gold.blob + offset, NAME_BYTES);
        offset += NAME_BYTES;
        memcpy(&at.dtype, gold.blob + offset, sizeof(uint32_t) * (2 + MAX_DIMS + 1));
        offset += sizeof(uint32_t) * (2 + MAX_DIMS + 1);
        at.data = gold.blob + offset;
        offset += at.nbytes + (4 - at.nbytes % 4) % 4;
    }
    gold.count = header[2];
    return true;
}

const GoldTensor *find(const GoldCase &gold, const char *name)
{
    for (size_t i = 0; i < gold.count; ++i) {
        if (strncmp(gold.tensors[i].name, name, NAME_BYTES) == 0) {
            return &gold.tensors[i];
        }
    }
    return nullptr;
}

const float *floats(const GoldCase &gold, const char *name)
{
    const GoldTensor *tensor = find(gold, name);
    TEST_ASSERT_NOT_NULL_MESSAGE(tensor, name);
    TEST_ASSERT_EQUAL_UINT32(DTYPE_F32, tensor->dtype);
    return reinterpret_cast<const float *>(tensor->data);
}

int32_t first_int(const GoldCase &gold, const char *name)
{
    const GoldTensor *tensor = find(gold, name);
    TEST_ASSERT_NOT_NULL_MESSAGE(tensor, name);
    TEST_ASSERT_EQUAL_UINT32(DTYPE_I32, tensor->dtype);
    return *reinterpret_cast<const int32_t *>(tensor->data);
}

ai::TensorView quantized(int h, int w, int c, void *data, size_t bytes, float scale, int zero_point)
{
    ai::TensorView tensor;
    tensor.rank = c > 0 ? 4 : 2;
    tensor.dims[0] = 1;
    tensor.dims[1] = c > 0 ? h : w;
    tensor.dims[2] = c > 0 ? w : 0;
    tensor.dims[3] = c;
    tensor.scale = scale;
    tensor.zero_point = zero_point;
    tensor.bytes = bytes;
    tensor.data = static_cast<int8_t *>(data);
    return tensor;
}

size_t case_count(const char *folder)
{
    char path[PATH_MAX_LEN];
    size_t found = 0;
    for (size_t i = 0; i < MAX_CASES; ++i) {
        snprintf(path, sizeof(path), GOLD_ROOT "/%s/case_%03u.gold", folder, static_cast<unsigned>(i));
        FILE *handle = fopen(path, "rb");
        if (handle == nullptr) {
            break;
        }
        fclose(handle);
        ++found;
    }
    return found;
}

void case_path(char *out, size_t cap, const char *folder, size_t index)
{
    snprintf(out, cap, GOLD_ROOT "/%s/case_%03u.gold", folder, static_cast<unsigned>(index));
}

void compare_floats(const float *got, const float *want, size_t count, const char *what)
{
    for (size_t i = 0; i < count; ++i) {
        const float error = fabsf(got[i] - want[i]);
        if (error > TOLERANCE) {
            printf("  %s[%u] board %.6f host %.6f\n", what, static_cast<unsigned>(i), got[i], want[i]);
        }
        TEST_ASSERT_FLOAT_WITHIN(TOLERANCE, want[i], got[i]);
    }
}

int compare_int8(const int8_t *got, const int8_t *want, size_t count, const char *what)
{
    size_t differing = 0;
    int worst = 0;
    for (size_t i = 0; i < count; ++i) {
        const int delta = abs(static_cast<int>(got[i]) - static_cast<int>(want[i]));
        if (delta != 0) {
            if (differing < 4) {
                printf("    %s[%u] board %d host %d\n", what, static_cast<unsigned>(i), got[i], want[i]);
            }
            ++differing;
            worst = delta > worst ? delta : worst;
        }
    }
    printf("  %s: %u of %u differ, worst %d lsb\n", what, static_cast<unsigned>(differing),
           static_cast<unsigned>(count), worst);
    return worst;
}

}  // namespace

TEST_CASE("the storage image carries every golden folder", "[parity]")
{
    mount_once();
    const char *folders[] = { "detection/decode", "detection/nms", "antispoof/preproc",
                              "recognition/align", "recognition/l2norm", "recognition/cosine" };
    for (size_t i = 0; i < sizeof(folders) / sizeof(folders[0]); ++i) {
        const size_t found = case_count(folders[i]);
        printf("  %s: %u case(s)\n", folders[i], static_cast<unsigned>(found));
        TEST_ASSERT_GREATER_THAN_UINT32(0, found);
    }
}

TEST_CASE("suppression keeps the boxes the host kept", "[parity]")
{
    mount_once();
    const size_t cases = case_count("detection/nms");
    TEST_ASSERT_GREATER_THAN_UINT32(0, cases);
    for (size_t c = 0; c < cases; ++c) {
        char path[PATH_MAX_LEN];
        case_path(path, sizeof(path), "detection/nms", c);
        GoldCase gold;
        TEST_ASSERT_TRUE_MESSAGE(load_case(path, gold), path);

        const GoldTensor *boxes = find(gold, "boxes");
        TEST_ASSERT_NOT_NULL(boxes);
        const size_t count = boxes->dims[0];
        const float *box_data = reinterpret_cast<const float *>(boxes->data);
        const float *scores = floats(gold, "scores");
        ai_engine_face_t faces[FACE_CAP];
        for (size_t i = 0; i < count; ++i) {
            memcpy(faces[i].box, box_data + i * 4, sizeof(faces[i].box));
            memset(faces[i].landmarks, 0, sizeof(faces[i].landmarks));
            faces[i].score = scores[i];
        }
        const size_t kept = ai::suppress(faces, count);
        printf("  case %u: %u box(es) -> %u\n", static_cast<unsigned>(c), static_cast<unsigned>(count),
               static_cast<unsigned>(kept));
        TEST_ASSERT_EQUAL_UINT32(static_cast<uint32_t>(first_int(gold, "kept")), kept);
        const float *want = floats(gold, "kept_boxes");
        for (size_t i = 0; i < kept; ++i) {
            compare_floats(faces[i].box, want + i * 4, 4, "kept_box");
        }
        free_case(gold);
    }
}

TEST_CASE("decode turns the golden head tensors into the golden faces", "[parity]")
{
    mount_once();
    static const char *kNames[HEADS] = { "cls_8", "box_8", "kps_8", "cls_16", "box_16",
                                         "kps_16", "cls_32", "box_32", "kps_32" };
    static const int kStrides[LEVELS] = { 8, 16, 32 };
    const size_t cases = case_count("detection/decode");
    TEST_ASSERT_GREATER_THAN_UINT32(0, cases);
    for (size_t c = 0; c < cases; ++c) {
        char path[PATH_MAX_LEN];
        case_path(path, sizeof(path), "detection/decode", c);
        GoldCase gold;
        TEST_ASSERT_TRUE_MESSAGE(load_case(path, gold), path);

        int8_t pixel = 0;
        const ai::TensorView input = quantized(DETECT_H, DETECT_W, 3, &pixel, 1, 1.0f, 0);
        ai::TensorView heads[HEADS];
        const float *quant = floats(gold, "quant");
        for (size_t i = 0; i < HEADS; ++i) {
            const GoldTensor *tensor = find(gold, kNames[i]);
            TEST_ASSERT_NOT_NULL_MESSAGE(tensor, kNames[i]);
            const int stride = kStrides[i / LEVELS];
            heads[i] = quantized(DETECT_H / stride, DETECT_W / stride, static_cast<int>(tensor->dims[2]),
                                 const_cast<uint8_t *>(tensor->data), tensor->nbytes, quant[2 * i],
                                 static_cast<int>(quant[2 * i + 1]));
        }
        ai_engine_face_t faces[FACE_CAP];
        const size_t found =
            ai::decode_faces(input, heads, HEADS, floats(gold, "min_score")[0], faces, FACE_CAP);
        printf("  case %u: board %u face(s), host %d\n", static_cast<unsigned>(c),
               static_cast<unsigned>(found), static_cast<int>(first_int(gold, "found")));
        TEST_ASSERT_EQUAL_INT32(first_int(gold, "found"), static_cast<int32_t>(found));
        const float *want_scores = floats(gold, "scores");
        const float *want_boxes = floats(gold, "boxes");
        const float *want_points = floats(gold, "landmarks");
        for (size_t i = 0; i < found; ++i) {
            TEST_ASSERT_FLOAT_WITHIN(TOLERANCE, want_scores[i], faces[i].score);
            compare_floats(faces[i].box, want_boxes + i * 4, 4, "box");
            compare_floats(faces[i].landmarks, want_points + i * 10, 10, "landmarks");
        }
        free_case(gold);
    }
}

TEST_CASE("the anti-spoof crop matches the golden block", "[parity]")
{
    mount_once();
    const size_t cases = case_count("antispoof/preproc");
    TEST_ASSERT_GREATER_THAN_UINT32(0, cases);
    int8_t *block = static_cast<int8_t *>(heap_caps_malloc(SPOOF_SIDE * SPOOF_SIDE * 3, MALLOC_CAP_SPIRAM));
    TEST_ASSERT_NOT_NULL(block);
    int worst = 0;
    for (size_t c = 0; c < cases; ++c) {
        char path[PATH_MAX_LEN];
        case_path(path, sizeof(path), "antispoof/preproc", c);
        GoldCase gold;
        TEST_ASSERT_TRUE_MESSAGE(load_case(path, gold), path);

        const GoldTensor *words = find(gold, "frame");
        TEST_ASSERT_NOT_NULL(words);
        ai_engine_frame_t frame = { reinterpret_cast<const uint16_t *>(words->data),
                                    static_cast<int>(words->dims[1]), static_cast<int>(words->dims[0]),
                                    false };
        const float *quant = floats(gold, "quant");
        const ai::TensorView input = quantized(SPOOF_SIDE, SPOOF_SIDE, 3, block, SPOOF_SIDE * SPOOF_SIDE * 3,
                                               quant[0], static_cast<int>(quant[1]));
        TEST_ASSERT_EQUAL(ESP_OK, ai::crop_face(frame, floats(gold, "box"), input, block, input.bytes));
        const GoldTensor *want = find(gold, "cropped");
        TEST_ASSERT_NOT_NULL(want);
        const int delta = compare_int8(block, reinterpret_cast<const int8_t *>(want->data), want->nbytes, "cropped");
        worst = delta > worst ? delta : worst;
        free_case(gold);
    }
    free(block);
    TEST_ASSERT_EQUAL_INT(0, worst);
}

TEST_CASE("align matches the golden block", "[parity]")
{
    mount_once();
    const size_t cases = case_count("recognition/align");
    TEST_ASSERT_GREATER_THAN_UINT32(0, cases);
    int8_t *block = static_cast<int8_t *>(heap_caps_malloc(ALIGN_SIDE * ALIGN_SIDE * 3, MALLOC_CAP_SPIRAM));
    TEST_ASSERT_NOT_NULL(block);
    int worst = 0;
    for (size_t c = 0; c < cases; ++c) {
        char path[PATH_MAX_LEN];
        case_path(path, sizeof(path), "recognition/align", c);
        GoldCase gold;
        TEST_ASSERT_TRUE_MESSAGE(load_case(path, gold), path);

        const GoldTensor *words = find(gold, "frame");
        TEST_ASSERT_NOT_NULL(words);
        ai_engine_frame_t frame = { reinterpret_cast<const uint16_t *>(words->data),
                                    static_cast<int>(words->dims[1]), static_cast<int>(words->dims[0]),
                                    false };
        const float *quant = floats(gold, "quant");
        const GoldTensor *want = find(gold, "aligned");
        TEST_ASSERT_NOT_NULL(want);
        // TFLM's recog reads 113 and ESP-DL's 112; each case carries the side it is cut for.
        const int side = static_cast<int>(want->dims[0]);
        TEST_ASSERT_LESS_OR_EQUAL_INT(ALIGN_SIDE, side);
        const ai::TensorView input = quantized(side, side, 3, block, static_cast<size_t>(side) * side * 3,
                                               quant[0], static_cast<int>(quant[1]));
        TEST_ASSERT_EQUAL(ESP_OK, ai::align_face(frame, floats(gold, "landmarks"), input, block, input.bytes));
        const int delta = compare_int8(block, reinterpret_cast<const int8_t *>(want->data), want->nbytes, "aligned");
        worst = delta > worst ? delta : worst;
        free_case(gold);
    }
    free(block);
    // align.py runs float64 and the device float32, so the warp cannot agree
    // to the last bit; ALIGN_LSB is the floor that difference sits at.
    TEST_ASSERT_LESS_OR_EQUAL_INT(ALIGN_LSB, worst);
}

TEST_CASE("the unit embedding matches the golden vector", "[parity]")
{
    mount_once();
    const size_t cases = case_count("recognition/l2norm");
    TEST_ASSERT_GREATER_THAN_UINT32(0, cases);
    int worst = 0;
    for (size_t c = 0; c < cases; ++c) {
        char path[PATH_MAX_LEN];
        case_path(path, sizeof(path), "recognition/l2norm", c);
        GoldCase gold;
        TEST_ASSERT_TRUE_MESSAGE(load_case(path, gold), path);

        const GoldTensor *raw = find(gold, "raw");
        TEST_ASSERT_NOT_NULL(raw);
        const float *quant = floats(gold, "quant");
        const ai::TensorView tensor = quantized(1, EMBED_DIM, 0, const_cast<uint8_t *>(raw->data), EMBED_DIM,
                                                quant[0], static_cast<int>(quant[1]));
        int8_t unit[EMBED_DIM];
        float scale = 0.0f;
        TEST_ASSERT_EQUAL_UINT32(EMBED_DIM, ai::normalized_int8(tensor, unit, sizeof(unit), &scale));
        const GoldTensor *want = find(gold, "unit");
        TEST_ASSERT_NOT_NULL(want);
        const int delta = compare_int8(unit, reinterpret_cast<const int8_t *>(want->data), EMBED_DIM, "unit");
        worst = delta > worst ? delta : worst;
        TEST_ASSERT_FLOAT_WITHIN(TOLERANCE, floats(gold, "scale")[0], scale);
        free_case(gold);
    }
    TEST_ASSERT_EQUAL_INT(0, worst);
}

TEST_CASE("the cosine of two templates matches the host", "[parity]")
{
    mount_once();
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_init());
    const size_t cases = case_count("recognition/cosine");
    TEST_ASSERT_GREATER_THAN_UINT32(0, cases);
    for (size_t c = 0; c < cases; ++c) {
        char path[PATH_MAX_LEN];
        case_path(path, sizeof(path), "recognition/cosine", c);
        GoldCase gold;
        TEST_ASSERT_TRUE_MESSAGE(load_case(path, gold), path);

        const GoldTensor *query = find(gold, "query");
        const GoldTensor *tmpl = find(gold, "template");
        TEST_ASSERT_NOT_NULL(query);
        TEST_ASSERT_NOT_NULL(tmpl);
        const float *scales = floats(gold, "scales");
        const uint32_t employee = 900u + static_cast<uint32_t>(c);
        TEST_ASSERT_EQUAL(ESP_OK,
                          svc_facedb_enroll(employee, 0, 100,
                                            reinterpret_cast<const int8_t *>(tmpl->data), scales[1],
                                            nullptr));
        svc_facedb_match_t match;
        TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(reinterpret_cast<const int8_t *>(query->data),
                                                    scales[0], &match));
        const float want = floats(gold, "similarity")[0];
        printf("  case %u: board %.6f host %.6f\n", static_cast<unsigned>(c), match.score, want);
        TEST_ASSERT_FLOAT_WITHIN(TOLERANCE, want, match.score);
        TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_remove(employee));
        free_case(gold);
    }
}

extern "C" void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
    unity_run_menu();
}
