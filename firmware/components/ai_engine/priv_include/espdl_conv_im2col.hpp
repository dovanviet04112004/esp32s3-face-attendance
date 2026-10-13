/** Build ConvIm2col for one .espdl node: an int8 kxk Conv over too few input channels for esp-dl's
 *  aligned kernels, run as its 1x1 kernel over each output pixel's patch gathered into channels.
 *  @ctx task | non-blocking | esp-dl's creator calls it while a dl::Model is built
 *  @ret the module, nullptr when the node is not an int8 2-D ungrouped convolution
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

dl::module::Module *conv_im2col_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
