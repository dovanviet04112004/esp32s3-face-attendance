// void ai_engine_conv_row_s8_esp32s3(int8_t *out, const int8_t *patches, const int8_t *filter, const int32_t *run)
// run: pixels, blocks of 16 outputs, 16-byte patch vectors a pixel, mac shift, bias in esp-dl's QACC layout or 0,
// activation (0 none, 1 ReLU, 2 PReLU), alpha (ReLU value or PReLU int8 pointer), activation shift, clamp top.
// Each pixel and block runs the steps of esp-dl 3.3.11's aligned int8 1x1 kernel; pointers 16-byte aligned.
//
// void ai_engine_conv_3x3x3_row_s8_esp32s3(int8_t *out, const int8_t *const *rows, const int8_t *filter,
//                                          const int32_t *run)
// rows: three image rows, each at the first pixel's 3x3x3 window, readable 32 bytes past the last window's start;
// run as above with the pixel step in bytes in place of the patch vectors, then the filter bytes past 27 taps a
// block. Same steps as the first function over the 27 patch channels that hold image bytes.

    .text
    .align  4
    .global ai_engine_conv_row_s8_esp32s3
    .type   ai_engine_conv_row_s8_esp32s3, @function
    .global ai_engine_conv_3x3x3_row_s8_esp32s3
    .type   ai_engine_conv_3x3x3_row_s8_esp32s3, @function

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

// From run: a6 pixels, a13 mac shift, a14 activation shift, q6 the clamp top in every byte, q7 ones.
.macro row_constants
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
.endm

// The 16 bytes at row, at any alignment, into q.
.macro load_window q, row, tmp, spare
    mov     \tmp, \row
    ee.ld.128.usar.ip   \q, \tmp, 16
    ee.vld.128.ip       \spare, \tmp, 0
    ee.src.q            \q, \q, \spare
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
    // The patch vectors run as esp-dl's tie728_s8_conv2d_11c16: the 16th MAC loads the next one.
    mov     a11, a3
    l32i    a15, a5, 8
    addi    a15, a15, -1
    ee.vld.128.ip   q0, a11, 16
    ee.vld.128.ip   q1, a8, 16
    ee.vld.128.ip   q2, a8, 16
    loopgtz a15, 5f
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
    ee.vsmulas.s8.qacc.ld.incp  q1, a8, q1, q0, 14
    ee.vsmulas.s8.qacc.ld.incp  q0, a11, q2, q0, 15
    ee.vld.128.ip   q2, a8, 16
5:
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

// Window rows in a3, a11, a12; tap p of a block weighs window row p / 9, byte p % 9.
.macro conv_3x3x3_loop act
1:
    load_window q0, a3, a15, q3
    load_window q1, a11, a15, q3
    load_window q2, a12, a15, q3
    l32i    a15, a5, 8
    add     a3, a3, a15
    add     a11, a11, a15
    add     a12, a12, a15
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
    ee.vld.128.ip   q3, a8, 16
    ee.vld.128.ip   q4, a8, 16
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q0, 0
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q0, 1
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q0, 2
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q0, 3
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q0, 4
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q0, 5
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q0, 6
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q0, 7
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q0, 8
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q1, 0
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q1, 1
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q1, 2
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q1, 3
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q1, 4
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q1, 5
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q1, 6
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q1, 7
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q1, 8
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q2, 0
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q2, 1
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q2, 2
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q2, 3
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q2, 4
    ee.vsmulas.s8.qacc.ld.incp  q4, a8, q4, q2, 5
    ee.vsmulas.s8.qacc.ld.incp  q3, a8, q3, q2, 6
    ee.vsmulas.s8.qacc  q4, q2, 7
    ee.vsmulas.s8.qacc  q3, q2, 8
    l32i    a15, a5, 36
    add     a8, a8, a15
    round_to    q5, a13, a15
  .if \act == 1
    ee.vrelu.s8     q5, a10, a14
  .elseif \act == 2
    ee.vld.128.ip   q3, a10, 16
    ee.vprelu.s8    q5, q5, q3, a14
  .endif
    ee.vmin.s8      q5, q5, q6
    ee.vst.128.ip   q5, a2, 16
    addi    a7, a7, -1
    bnez    a7, 2b
    addi    a6, a6, -1
    bnez    a6, 1b
.endm

ai_engine_conv_row_s8_esp32s3:
    entry   a1, 48
    row_constants
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

    .align  4
ai_engine_conv_3x3x3_row_s8_esp32s3:
    entry   a1, 48
    l32i    a11, a3, 4
    l32i    a12, a3, 8
    l32i    a3, a3, 0
    row_constants
    l32i    a15, a5, 20
    beqz    a15, .Lwindow_plain
    addi    a15, a15, -1
    beqz    a15, .Lwindow_relu
    conv_3x3x3_loop 2
    retw.n
.Lwindow_relu:
    l32i    a10, a5, 24
    conv_3x3x3_loop 1
    retw.n
.Lwindow_plain:
    conv_3x3x3_loop 0
    retw.n
