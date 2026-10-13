/** Build PointwiseDepthwise for one .espdl node: a 1x1 convolution and the depthwise one reading it, run
 *  band by band so the middle rows stay in a cache-sized buffer, each by esp-dl's own kernel (KEHOACH 3.7).
 *  @ctx task | non-blocking | esp-dl's creator calls it while a dl::Model is built
 *  @ret the module, nullptr when the node is not an int8 pair esp_ppq_patches joins
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

dl::module::Module *pointwise_depthwise_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
