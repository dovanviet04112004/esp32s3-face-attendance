// int32_t facedb_dot_s8_esp32s3(const int8_t *query, const int8_t *tmpl, int32_t len)
// query: 16-byte aligned. tmpl: 8-byte aligned. len: multiple of 16, at least 16.
// Sixteen products per ee.vmulas.s8.accx into the 40-bit ACCX; the low 32 bits
// hold any int8 dot of 512 lanes (|sum| <= 512 * 127 * 127).

    .text
    .align  4
    .global facedb_dot_s8_esp32s3
    .type   facedb_dot_s8_esp32s3, @function

facedb_dot_s8_esp32s3:
    entry   a1, 32
    ee.zero.accx
    srli    a5, a4, 4
    loopgtz a5, .Ldone
    ee.vld.128.ip   q0, a2, 16
    ee.vld.l.64.ip  q1, a3, 8
    ee.vld.h.64.ip  q1, a3, 8
    ee.vmulas.s8.accx   q0, q1
.Ldone:
    nop
    nop
    rur.accx_0      a2
    retw.n
