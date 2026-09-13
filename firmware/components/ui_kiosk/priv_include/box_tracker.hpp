/** Slides the last detector box along with the face between two detects,
 *  by matching a small brightness patch from frame to frame (KEHOACH 4.5.5h).
 *  @ctx ui_task | non-blocking, about one to two ms per frame | display only
 */
#pragma once

#include <stdint.h>

namespace ui {

struct Box {
    float x1;
    float y1;
    float x2;
    float y2;
};

class BoxTracker {
public:
    static constexpr int kStep = 2;                        // frame pixels per tracking pixel
    static constexpr int kPatch = 24;                      // template side, tracking pixels
    static constexpr int kRadius = 16;                     // search radius, tracking pixels
    static constexpr int kCoarseStep = 2;                  // tracking pixels between coarse tries
    static constexpr int kWindow = kPatch + 2 * kRadius;

    /** Take a fresh box from the detector and capture the patch under its centre.
     *  @param high_byte_first true for a sensor frame, false for words built here
     */
    void set(const Box &box, const uint16_t *frame, int width, int height,
             bool high_byte_first) noexcept;

    /** Move the box to where its patch went in this frame.
     *  @ret false when nothing is tracked or the patch is lost; the box then stays
     */
    bool update(const uint16_t *frame, int width, int height) noexcept;

    bool active() const noexcept { return active_; }
    const Box &box() const noexcept { return box_; }
    void clear() noexcept { active_ = false; }

private:
    void sample(const uint16_t *frame, int width, int left, int top, int side, uint8_t *out) const noexcept;
    bool high_byte_first_ = false;
    uint32_t sad(int col, int row, uint32_t ceiling) const noexcept;

    uint8_t template_[kPatch * kPatch] = {};
    uint8_t window_[kWindow * kWindow] = {};
    Box box_ = {};
    int patch_left_ = 0;                                   // frame pixels
    int patch_top_ = 0;
    bool active_ = false;
};

}  // namespace ui
