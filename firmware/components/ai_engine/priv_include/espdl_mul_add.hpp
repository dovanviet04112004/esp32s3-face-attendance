/** Build MulAdd for one .espdl node: x times its per-channel gate plus a residual, run row by row with
 *  esp-dl's own int8 elementwise kernels, all three on the output's exponent (KEHOACH 3.7).
 *  @ctx task | non-blocking | esp-dl's creator calls it while a dl::Model is built
 *  @ret the module, nullptr when the node is not int8
 */
#pragma once

#include <string>

namespace dl::module {
class Module;
}  // namespace dl::module

namespace fbs {
class FbsModel;
}  // namespace fbs

namespace ai {

dl::module::Module *mul_add_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
