/** Build ConvSlices for one .espdl node: a 1x1 int8 Conv cut by output channel into slices that
 *  each write their own channels of one output tensor (KEHOACH 3.7).
 *  @ctx task | non-blocking | esp-dl's creator calls it while a dl::Model is built
 *  @ret the module, nullptr when the node is not an int8 1x1 convolution
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

dl::module::Module *conv_slices_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
