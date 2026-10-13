/** Build ConvPRelu for one .espdl node: an int8 2-D Conv and the PReLU that alone reads it, run in
 *  one S3 kernel (KEHOACH 3.7).
 *  @ctx task | non-blocking | esp-dl's creator calls it while a dl::Model is built
 *  @ret the module, nullptr when the node is not an int8 2-D convolution
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

dl::module::Module *conv_prelu_from(fbs::FbsModel *fbs_model, std::string node_name);

}  // namespace ai
