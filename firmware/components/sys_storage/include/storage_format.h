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

#define STORAGE_FACES_PATH "/lfs/db/faces.bin"  // KEHOACH 6.2.3
#define STORAGE_ATTEND_DIR "/lfs/log"             // KEHOACH 6.2.5
#define STORAGE_ATTEND_FMT "/lfs/log/attend.%03u"  // 000 to 999
#define STORAGE_ATTEND_FILES 1000u
#define STORAGE_CURSOR_PATH "/lfs/log/cursor.bin"
#define STORAGE_FACES_MAGIC 0x31424446u   // 'FDB1'
#define STORAGE_FACES_VER 3u
#define STORAGE_FACES_VER_UNTAGGED 2u     // same records, no model tag in the header
#define STORAGE_MODEL_TAG_LEN 8           // leading bytes of the recog entry's sha256
#define STORAGE_NAME_CAP 32
#define STORAGE_FACE_MAGIC 0x45434146u    // 'FACE'
#define STORAGE_FACE_FLAG_ACTIVE 0x01u
#define STORAGE_FACE_FLAG_DELETED 0x02u
#define STORAGE_FACE_FLAG_UNREPORTED 0x04u  // captured here, not yet acked by the broker
#define STORAGE_EMBED_DIM 512

#define STORAGE_ATTEND_MAGIC 0x31474C41u  // 'ALG1'
#define STORAGE_ATTEND_VER 1u
#define STORAGE_ATTEND_REC_MAGIC 0x44545441u  // 'ATTD'
#define STORAGE_ATTEND_ROTATE_BYTES (256 * 1024)
#define STORAGE_CURSOR_MAGIC 0x31554341u  // 'ACU1'
#define STORAGE_CURSOR_VER 1u
#define STORAGE_ATTEND_FLAG_DOOR 0x01u    // the door opened for this punch
#define STORAGE_ATTEND_FLAG_OFFLINE 0x02u // stamped with no broker link
#define STORAGE_ATTEND_FLAG_NO_NTP 0x04u  // ts came from a clock never NTP set
#define STORAGE_ATTEND_DIR_IN 0u
#define STORAGE_ATTEND_DIR_OUT 1u
#define STORAGE_ATTEND_SCORE_ONE 256      // Q8.8: a score of 1.0

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
    uint8_t model_tag[STORAGE_MODEL_TAG_LEN];  // faces.bin: whose embeddings; a log: 0
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
    char name[STORAGE_NAME_CAP];          // UTF-8, terminated; empty shows the id
    uint8_t reserved[4];
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

#define STORAGE_PENDING_MAGIC 0x32444E50u    // 'PND2'
#define STORAGE_PENDING_CAP 64
#define STORAGE_ENROLL_OUT_MAGIC 0x3154554Fu // 'OUT1'
#define STORAGE_ENROLL_OUT_CAP 8

/** One person this kiosk is to capture, as the server named them (KEHOACH 7.5).
 */
typedef struct __attribute__((packed)) {
    uint32_t employee_id;
    char name[STORAGE_NAME_CAP];          // UTF-8, terminated
} storage_pending_row_t;

/** NVS device/pending: who waits for a capture here, kept across a reboot offline (KEHOACH 6.2.1).
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t count;
    uint8_t reserved[3];
    storage_pending_row_t row[STORAGE_PENDING_CAP];
} storage_pending_t;

/** One operator request the broker has not acked (KEHOACH 7.5).
 */
typedef struct __attribute__((packed)) {
    uint8_t op;                           // enroll_payload_op_t: RETAKE or DELETE_EMPLOYEE
    uint8_t reserved[3];
    uint32_t employee_id;
} storage_enroll_ask_t;

/** NVS device/enroll_out: requests to send at least once, oldest first (KEHOACH 6.2.1).
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t count;
    uint8_t reserved[3];
    storage_enroll_ask_t ask[STORAGE_ENROLL_OUT_CAP];
} storage_enroll_out_t;

/** How far the uplink has got through the log. Only an acked record moves it,
 *  so a power cut costs a resend and never a record (KEHOACH 6.2.5).
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t format_ver;
    uint16_t file_index;                  // which attend.NNN
    uint32_t offset;                      // next byte in it, 32 + k * 48
    uint32_t crc32;
} storage_cursor_t;

// The compiler holds these numbers, so a field added without a version bump
// breaks the build rather than writing records the next firmware cannot read.
static_assert(sizeof(storage_model_entry_t) == 64, "model entry must match KEHOACH 6.2.2");
static_assert(sizeof(storage_models_header_t) == 256, "models header must match KEHOACH 6.2.2");
static_assert(offsetof(storage_models_header_t, entry) == 0x10, "model entry offset drifted");
static_assert(offsetof(storage_models_header_t, crc32) == 0xFC, "models crc offset drifted");

static_assert(sizeof(storage_file_header_t) == 32, "file header must match KEHOACH 6.2.4");
static_assert(offsetof(storage_file_header_t, model_tag) == 20, "file header tag offset drifted");
static_assert(offsetof(storage_file_header_t, crc32) == 28, "file header crc offset drifted");

static_assert(sizeof(storage_face_record_t) == 576, "face record must match KEHOACH 6.2.4");
static_assert(offsetof(storage_face_record_t, embedding) == 16, "embedding offset drifted");
static_assert(offsetof(storage_face_record_t, crc32) == 572, "face crc offset drifted");

static_assert(sizeof(storage_pending_row_t) == 36, "pending row must match KEHOACH 6.2.1");
static_assert(sizeof(storage_pending_t) == 2312, "pending blob must match KEHOACH 6.2.1");
static_assert(sizeof(storage_enroll_ask_t) == 8, "enrol request must match KEHOACH 6.2.1");
static_assert(sizeof(storage_enroll_out_t) == 72, "enrol outbox must match KEHOACH 6.2.1");

static_assert(sizeof(storage_attend_record_t) == 48, "attend record must match KEHOACH 6.2.5");
static_assert(offsetof(storage_attend_record_t, ts_ms) == 16, "attend ts offset drifted");
static_assert(offsetof(storage_attend_record_t, crc32) == 44, "attend crc offset drifted");

static_assert(sizeof(storage_cursor_t) == 16, "cursor must match KEHOACH 6.2.5");
static_assert(offsetof(storage_cursor_t, offset) == 8, "cursor offset field drifted");
