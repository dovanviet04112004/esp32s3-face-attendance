// void ai_engine_max_pool_s8_esp32s3(int8_t *out, const int8_t *rows, const int32_t *run)
// run: output rows, output pixels a row, 16-byte vectors a pixel, bytes an input row. Each output pixel is the
// bytewise max of the 2x2 input pixels it covers, two input rows an output row; pointers 16-byte aligned, counts >= 1.

    .text
    .align  4
    .global ai_engine_max_pool_s8_esp32s3
    .type   ai_engine_max_pool_s8_esp32s3, @function

ai_engine_max_pool_s8_esp32s3:
    entry   a1, 32
    l32i    a5, a4, 0
    l32i    a6, a4, 4
    l32i    a7, a4, 8
    l32i    a8, a4, 12
    slli    a9, a7, 4
1:
    mov     a10, a3
    add     a11, a3, a8
    mov     a12, a6
2:
    mov     a13, a7
3:
    add     a14, a10, a9
    add     a15, a11, a9
    ee.vld.128.ip   q0, a10, 16
    ee.vld.128.ip   q1, a14, 0
    ee.vld.128.ip   q2, a11, 16
    ee.vld.128.ip   q3, a15, 0
    ee.vmax.s8      q0, q0, q1
    ee.vmax.s8      q2, q2, q3
    ee.vmax.s8      q0, q0, q2
    ee.vst.128.ip   q0, a2, 16
    addi    a13, a13, -1
    bnez    a13, 3b
    add     a10, a10, a9
    add     a11, a11, a9
    addi    a12, a12, -1
    bnez    a12, 2b
    add     a3, a3, a8
    add     a3, a3, a8
    addi    a5, a5, -1
    bnez    a5, 1b
    retw.n
