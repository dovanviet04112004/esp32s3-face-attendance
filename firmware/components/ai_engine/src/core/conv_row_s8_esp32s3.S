// void ai_engine_conv_row_s8_esp32s3(int8_t *out, const int8_t *patches, const int8_t *filter, const int32_t *run)
// run: pixels, blocks of 16 outputs, 16-byte patch vectors a pixel, mac shift, bias in esp-dl's QACC layout or 0,
// activation (0 none, 1 ReLU, 2 PReLU), alpha (ReLU value or PReLU int8 pointer), activation shift, clamp top.
// Each pixel and block runs the steps of esp-dl 3.3.11's aligned int8 1x1 kernel; pointers 16-byte aligned.

    .text
    .align  4
    .global ai_engine_conv_row_s8_esp32s3
    .type   ai_engine_conv_row_s8_esp32s3, @function

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

.macro conv_row_loop act
1:
    mov     a8, a4
    l32i    a9, a5, 16
  .if \act == 2
    l32i    a10, a5, 24
  .endif
    l32i    a7, a5, 4
2:
    beqz    a9, 3f
    ee.ld.qacc_l.l.128.ip   a9, 16
    ee.ld.qacc_l.h.32.ip    a9, 16
    ee.ld.qacc_h.l.128.ip   a9, 16
    ee.ld.qacc_h.h.32.ip    a9, 16
    j       4f
3:
    ee.zero.qacc
4:
    mov     a11, a3
    l32i    a12, a5, 8
5:
    ee.vld.128.ip   q0, a11, 16
    ee.vld.128.ip   q1, a8, 16
    ee.vld.128.ip   q2, a8, 16
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 0
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 1
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 2
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 3
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 4
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 5
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 6
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 7
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 8
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 9
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 10
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 11
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 12
    ee.vsmulas.s8.qacc.ld.incp  q2, a8, q2, q0, 13
    ee.vsmulas.s8.qacc  q1, q0, 14
    ee.vsmulas.s8.qacc  q2, q0, 15
    addi    a12, a12, -1
    bnez    a12, 5b
    round_to    q3, a13, a15
  .if \act == 1
    ee.vrelu.s8     q3, a10, a14
  .elseif \act == 2
    ee.vld.128.ip   q4, a10, 16
    ee.vprelu.s8    q3, q3, q4, a14
  .endif
    ee.vmin.s8      q3, q3, q6
    ee.vst.128.ip   q3, a2, 16
    addi    a7, a7, -1
    bnez    a7, 2b
    l32i    a15, a5, 8
    slli    a15, a15, 4
    add     a3, a3, a15
    addi    a6, a6, -1
    bnez    a6, 1b
.endm

ai_engine_conv_row_s8_esp32s3:
    entry   a1, 48
    l32i    a6, a5, 0
    l32i    a13, a5, 12
    l32i    a14, a5, 28
    addi    a15, a5, 32
    ee.vldbc.8      q6, a15
    movi    a15, 257
    ee.movi.32.q    q7, a15, 0
    ee.movi.32.q    q7, a15, 1
    ee.movi.32.q    q7, a15, 2
    ee.movi.32.q    q7, a15, 3
    movi.n  a15, 16
    wsr.sar a15
    ee.vsl.32       q5, q7
    ee.orq          q7, q5, q7
    l32i    a15, a5, 20
    beqz    a15, .Lplain
    bgei    a15, 2, .Lsloped
    l32i    a10, a5, 24
    conv_row_loop 1
    retw.n
.Lsloped:
    conv_row_loop 2
    retw.n
.Lplain:
    conv_row_loop 0
    retw.n
