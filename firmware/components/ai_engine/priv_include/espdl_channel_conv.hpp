/** Build ChannelConv for one .espdl node: ECA's 1-D convolution along the channels of a 1x1xC map,
 *  rounded half up and saturated as esp-dl's convolution kernels do (KEHOACH 3.7).
 *  @ctx task | non-blocking | esp-dl's creator calls it while a dl::Model is built
 *  @ret the module, nullptr when the node is not an int8 1-D kernel
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

dl::module::Module *channel_conv_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
