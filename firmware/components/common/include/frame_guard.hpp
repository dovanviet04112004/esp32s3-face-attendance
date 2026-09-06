/** Returns a camera frame to the pool when the scope ends.
 *  @ctx task | non-blocking | the including component supplies esp32-camera
 */
#pragma once

#include "esp_camera.h"

namespace app {

class FrameGuard {
public:
    explicit FrameGuard(camera_fb_t *fb) noexcept : fb_(fb) {}

    ~FrameGuard()
    {
        if (fb_ != nullptr) {
            esp_camera_fb_return(fb_);
        }
    }

    FrameGuard(const FrameGuard &) = delete;
    FrameGuard &operator=(const FrameGuard &) = delete;

    FrameGuard(FrameGuard &&other) noexcept : fb_(other.fb_) { other.fb_ = nullptr; }

    camera_fb_t *get() const noexcept { return fb_; }
    bool valid() const noexcept { return fb_ != nullptr; }

private:
    camera_fb_t *fb_;
};

}  // namespace app
