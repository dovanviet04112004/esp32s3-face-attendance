// void ai_engine_clamp_s8_esp32s3(int8_t *values, int32_t vectors, const int8_t *top)
// values: 16-byte aligned, clamped in place to at most *top. vectors: 16 bytes each, at least 1.
// Each load runs one vector ahead of its store, so the clamp may write over what it reads.

    .text
    .align  4
    .global ai_engine_clamp_s8_esp32s3
    .type   ai_engine_clamp_s8_esp32s3, @function

ai_engine_clamp_s8_esp32s3:
    entry   a1, 32
    ee.vldbc.8      q1, a4
    mov             a5, a2
    ee.vld.128.ip   q0, a5, 16
    addi            a3, a3, -1
    loopgtz a3, .Ldone
    ee.vmin.s8.ld.incp  q0, a5, q2, q0, q1
    ee.vst.128.ip   q2, a2, 16
.Ldone:
    ee.vmin.s8      q2, q0, q1
    ee.vst.128.ip   q2, a2, 16
    retw.n
