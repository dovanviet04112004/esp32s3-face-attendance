/** Build SpatialMean for one .espdl node: an int8 ReduceMean over both spatial axes, its sums taken in QACC by
 *  esp-dl's avg_pool2d kernel and scaled per channel exactly as esp-dl's ReduceMean scales (KEHOACH 3.7).
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

dl::module::Module *spatial_mean_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
