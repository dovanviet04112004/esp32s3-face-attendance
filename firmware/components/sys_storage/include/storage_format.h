/** Every binary layout that reaches flash, in the one file allowed to hold them.
 *  @ctx any | non-blocking | a 1:1 translation of KEHOACH 6.2
 */
#pragma once

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

#define STORAGE_MODELS_MAGIC 0x534C444Du  // 'MDLS'
#define STORAGE_MODELS_VER 1u
#define STORAGE_MODEL_COUNT 3
#define STORAGE_MODEL_NAME_LEN 16
#define STORAGE_SHA256_LEN 32
#define STORAGE_MODEL_ALIGN 16            // esp-nn reads the weights aligned

#define STORAGE_FACES_MAGIC 0x31424446u   // 'FDB1'
#define STORAGE_FACES_VER 1u
#define STORAGE_FACE_MAGIC 0x45434146u    // 'FACE'
#define STORAGE_EMBED_DIM 512

#define STORAGE_ATTEND_MAGIC 0x31474C41u  // 'ALG1'
#define STORAGE_ATTEND_REC_MAGIC 0x44545441u  // 'ATTD'
#define STORAGE_ATTEND_ROTATE_BYTES (256 * 1024)

/** One model inside the packed image, found by name rather than by position.
 */
typedef struct __attribute__((packed)) {
    char name[STORAGE_MODEL_NAME_LEN];
    uint32_t offset;
    uint32_t size;
    uint8_t sha256[STORAGE_SHA256_LEN];
    uint16_t in_h;
    uint16_t in_w;
    uint32_t arena_hint;
} storage_model_entry_t;

/** Head of the models partition, read once and then used as a lookup table.
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t format_ver;
    uint32_t count;
    uint32_t built_at;
    storage_model_entry_t entry[STORAGE_MODEL_COUNT];
    uint8_t reserved[44];
    uint32_t crc32;
} storage_models_header_t;

/** Head of a record file. The attendance log reuses it with its own magic.
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t format_ver;
    uint16_t record_size;
    uint32_t record_count;
    int64_t updated_at_ms;
    uint8_t reserved[8];
    uint32_t crc32;
} storage_file_header_t;

/** One enrolled template. Deleting a person sets a flag rather than moving
 *  records, so an offset stays valid for the life of the file (KEHOACH 6.2.4).
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t employee_id;
    uint16_t template_idx;
    uint8_t quality;                      // 0-255, picks between duplicates
    uint8_t flags;                        // bit0 active, bit1 deleted
    float scale;                          // dequant for the int8 embedding
    int8_t embedding[STORAGE_EMBED_DIM];
    int64_t updated_at_ms;
    uint8_t reserved[12];
    uint32_t crc32;
} storage_face_record_t;

/** One attendance event. Each is synced as it lands, so a power cut costs at
 *  most the record being written (KEHOACH 6.2.6).
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint64_t local_id;                    // boot_count << 32 | seq, never repeats
    uint32_t employee_id;
    int64_t ts_ms;
    uint8_t direction;                    // 0 in, 1 out
    uint16_t match_score;                 // Q8.8
    uint16_t liveness_score;              // Q8.8
    uint8_t flags;                        // bit0 door opened, bit1 offline, bit2 no ntp
    uint16_t model_version;
    uint8_t reserved[12];
    uint32_t crc32;
} storage_attend_record_t;

// The compiler holds these numbers, so a field added without a version bump
// breaks the build rather than writing records the next firmware cannot read.
static_assert(sizeof(storage_model_entry_t) == 64, "model entry must match KEHOACH 6.2.2");
static_assert(sizeof(storage_models_header_t) == 256, "models header must match KEHOACH 6.2.2");
static_assert(offsetof(storage_models_header_t, entry) == 0x10, "model entry offset drifted");
static_assert(offsetof(storage_models_header_t, crc32) == 0xFC, "models crc offset drifted");

static_assert(sizeof(storage_file_header_t) == 32, "file header must match KEHOACH 6.2.4");
static_assert(offsetof(storage_file_header_t, crc32) == 28, "file header crc offset drifted");

static_assert(sizeof(storage_face_record_t) == 552, "face record must match KEHOACH 6.2.4");
static_assert(offsetof(storage_face_record_t, embedding) == 16, "embedding offset drifted");
static_assert(offsetof(storage_face_record_t, crc32) == 548, "face crc offset drifted");

static_assert(sizeof(storage_attend_record_t) == 48, "attend record must match KEHOACH 6.2.5");
static_assert(offsetof(storage_attend_record_t, ts_ms) == 16, "attend ts offset drifted");
static_assert(offsetof(storage_attend_record_t, crc32) == 44, "attend crc offset drifted");
