/** ai_engine's own ESP-DL modules, made known to esp-dl's creator beside its built-in ones.
 *  ConvPRelu runs a 2-D int8 Conv and the PReLU that alone reads it in one S3 kernel (KEHOACH 3.7).
 *  @ctx task | non-blocking | idempotent; the first dl::Model needs it called already
 */
#pragma once

namespace ai {

void register_espdl_modules() noexcept;

}  // namespace ai
