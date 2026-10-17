// void ai_engine_mul_add_s8_esp32s3(int8_t *out, const int8_t *x, const int8_t *gate, const int8_t *residual,
//                                   const int32_t *run)
// run: pixels, 16-byte vectors a pixel, product right shift, residual right shift, residual left scale or 0.
// Pointers 16-byte aligned, counts at least 1. Same steps as esp-dl 3.3.11's int8 Mul, requantize and Add.

    .text
    .align  4
    .global ai_engine_mul_add_s8_esp32s3
    .type   ai_engine_mul_add_s8_esp32s3, @function

// q7 holds 1 in every byte. Leaves int8 saturate(round half up(qacc >> shift)) in out.
.macro round_to out, shift, tmp
    beqz    \shift, 8f
    addi    \tmp, \shift, -1
    ee.srcmb.s8.qacc    \out, \tmp, 0
    movi.n  \tmp, 1
    ee.movi.32.q    \out, \tmp, 0
    ee.vsmulas.s8.qacc  q7, \out, 0
    ee.srcmb.s8.qacc    \out, \tmp, 0
    j       9f
8:
    ee.srcmb.s8.qacc    \out, \shift, 0
9:
.endm

// mode 0 adds the residual as it is, 1 shifts it right onto the output grid, 2 scales it up.
.macro mul_add_loop mode
1:
    mov     a12, a4
    mov     a13, a8
2:
    ee.vld.128.ip   q0, a3, 16
    ee.vld.128.ip   q1, a12, 16
    ee.zero.qacc
    ee.vmulas.s8.qacc   q0, q1
    round_to    q2, a9, a14
  .if \mode == 0
    ee.vld.128.ip   q3, a5, 16
  .elseif \mode == 1
    ee.ldqa.s8.128.ip   a5, 16
    round_to    q3, a10, a14
  .else
    ee.vld.128.ip   q3, a5, 16
    ee.zero.qacc
    ee.vmulas.s8.qacc   q3, q6
    ee.srcmb.s8.qacc    q3, a15, 0
  .endif
    ee.vadds.s8     q2, q2, q3
    ee.vst.128.ip   q2, a2, 16
    addi    a13, a13, -1
    bnez    a13, 2b
    addi    a7, a7, -1
    bnez    a7, 1b
.endm

ai_engine_mul_add_s8_esp32s3:
    entry   a1, 48
    l32i    a7, a6, 0
    l32i    a8, a6, 4
    l32i    a9, a6, 8
    l32i    a10, a6, 12
    addi    a11, a6, 16
    ee.vldbc.8      q6, a11
    l32i    a11, a6, 16
    movi    a12, 257
    ee.movi.32.q    q7, a12, 0
    ee.movi.32.q    q7, a12, 1
    ee.movi.32.q    q7, a12, 2
    ee.movi.32.q    q7, a12, 3
    movi.n  a12, 16
    wsr.sar a12
    ee.vsl.32       q5, q7
    ee.orq          q7, q5, q7
    movi.n  a15, 0
    bnez    a11, .Lscaled
    bnez    a10, .Lshifted
    mul_add_loop 0
    retw.n
.Lshifted:
    mul_add_loop 1
    retw.n
.Lscaled:
    mul_add_loop 2
    retw.n
