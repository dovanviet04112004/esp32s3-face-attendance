/** Build MulAdd for one .espdl node: x times its per-channel gate plus a residual, one PIE loop over the
 *  whole tensor taking the steps of esp-dl's int8 Mul, requantize and Add (KEHOACH 3.7).
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
