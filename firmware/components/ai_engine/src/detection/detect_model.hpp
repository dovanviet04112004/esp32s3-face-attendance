/** The detection branch: one letterboxed frame in, raw head tensors out.
 *  @ctx task | invoke blocks | layer 2 of the pipeline in KEHOACH 3
 */
#pragma once

#include <stddef.h>

#include "ai_engine.h"
#include "tensor_view.hpp"
#include "tflite_model.hpp"

namespace ai {

// YuNet's three heads at three strides; the graph may list them in any order.
constexpr size_t kDetectHeads = 9;

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &detect_ops() noexcept;

class DetectModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "detect"; }

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return detect_ops(); }
};

/** Faces from the head tensors of the run that just finished, best first and
 *  already suppressed; boxes and landmarks in detector input pixels.
 *  @ctx ai_task | non-blocking | reads the model's output tensors in place
 *  @param heads count views, any order; the input view gives the grid sizes
 */
size_t decode_faces(const TensorView &input, const TensorView *heads, size_t count, float min_score,
                    ai_engine_face_t *out, size_t cap) noexcept;

/** Greedy NMS over faces sorted best first, in place; returns how many stay.
 *  @ctx any | non-blocking
 */
size_t suppress(ai_engine_face_t *faces, size_t count) noexcept;

/** Fit a camera frame into the detector's input tensor, black bars around it,
 *  and report the geometry that maps its boxes back (letterbox_params in ml).
 *  @ctx ai_task | blocking for the resample
 */
esp_err_t letterbox_frame(const ai_engine_frame_t &frame, const TensorView &input,
                          ai_engine_letterbox_t *geometry) noexcept;

}  // namespace ai
