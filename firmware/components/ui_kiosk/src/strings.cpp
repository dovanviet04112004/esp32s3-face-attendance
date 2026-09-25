#include "strings.hpp"

#include <stddef.h>
#include <string.h>

namespace ui {

namespace {

struct Entry {
    StrId id;
    const char *vi;
    const char *en;
};

constexpr Entry kRows[] = {
    { StrId::ScanFrame, "Đưa khuôn mặt vào khung", "Centre your face" },
    { StrId::ScanTooFar, "Lại gần hơn", "Move closer" },
    { StrId::ScanTooClose, "Lùi lại một chút", "Step back a little" },
    { StrId::ScanWorking, "Đang nhận diện…", "Checking…" },
    { StrId::ScanSpoof, "Ảnh giả, mời thử lại", "Not a live face" },
    { StrId::ScanUnknown, "Chưa có trong hệ thống", "Not enrolled yet" },
    { StrId::ScanDenied, "Chưa nhận được, thử lại", "Not recognised" },
    { StrId::ScanCheckedIn, "Đã chấm công", "Checked in" },
    { StrId::ScanCodeFmt, "Mã %u", "ID %u" },
    { StrId::TicketWaitingFmt, "Chờ duyệt · %s", "Pending · %s" },
    { StrId::TicketClaimFmt, "Mã nhận máy %s", "Claim code %s" },
    { StrId::TicketRefused, "Máy chủ không nhận firmware này", "Server refused this firmware" },
    { StrId::TicketNoToken, "Firmware này chưa có mã lô", "Firmware has no batch token" },
    { StrId::TicketOffline, "Chưa nối được máy chủ", "Cannot reach the server" },
    { StrId::UpdateFetchingFmt, "Đang tải bản cập nhật %u%%", "Downloading an update %u%%" },
    { StrId::UpdateRestarting, "Đang khởi động lại để cập nhật…", "Restarting to update…" },
    { StrId::UpdateTitle, "Đang cập nhật", "Updating" },
    { StrId::UpdateVersionFmt, "Phiên bản %s", "Version %s" },
    { StrId::UpdateConnecting, "Đang kết nối máy chủ…", "Connecting to the server…" },
    { StrId::UpdateChecking, "Đang kiểm tra bản cập nhật…", "Checking the update…" },
    { StrId::UpdatePaused, "Tạm dừng chấm công trong lúc cập nhật", "Check-in is paused while updating" },
    { StrId::UpdateCaptureDropped, "Lượt chụp mẫu đã huỷ vì máy cập nhật", "The capture was cancelled for the update" },
    { StrId::UpdateFailed, "Cập nhật không thành công", "The update did not go through" },
    { StrId::UpdateWhyOther, "Có lỗi khi cập nhật", "Something went wrong" },
    { StrId::UpdateWhyNetwork, "Mất mạng giữa chừng", "The connection dropped" },
    { StrId::UpdateWhyDigest, "Tệp tải về bị hỏng", "The download was damaged" },
    { StrId::UpdateWhyRefused, "Máy chủ không cho tải", "The server refused the download" },
    { StrId::UpdateWhyTooBig, "Bản cập nhật quá lớn cho máy này", "Too large for this kiosk" },
    { StrId::UpdateResumeFmt, "Chấm công lại sau %u giây", "Check-in resumes in %u s" },
    { StrId::UpdateDoneFmt, "Đã cập nhật lên %s", "Updated to %s" },

    { StrId::MenuTitle, "Quản lý", "Manage" },
    { StrId::MenuEnrol, "Thêm người", "Add person" },
    { StrId::MenuPeople, "Danh sách", "People" },
    { StrId::MenuSettings, "Cài đặt", "Settings" },
    { StrId::MenuClose, "Đóng", "Close" },

    { StrId::SettingsLanguage, "Ngôn ngữ", "Language" },
    { StrId::SettingsDevice, "Thiết bị của tôi", "My device" },
    { StrId::SettingsNotJoined, "Chưa nối", "Not joined" },
    { StrId::SettingsDisplay, "Màn hình và âm thanh", "Display and sound" },

    { StrId::DeviceNoFacts, "Chưa có số liệu", "No readings yet" },
    { StrId::DeviceVersion, "Phiên bản", "Version" },
    { StrId::DeviceId, "Mã máy", "Device ID" },
    { StrId::DeviceEnrolled, "Người đã thêm", "Enrolled" },
    { StrId::DeviceRecords, "Bản ghi", "Records" },
    { StrId::DeviceWifiDrops, "Wi-Fi rớt", "Wi-Fi drops" },
    { StrId::DeviceWakeWithin, "Bật máy trong", "Wakes within" },
    { StrId::DeviceMinFace, "Mặt nhỏ nhất", "Smallest face" },
    { StrId::DeviceRamFree, "RAM nội còn", "RAM free" },

    { StrId::EnrolNobody, "Chưa ai được giao từ máy chủ", "Nobody assigned yet" },
    { StrId::EnrolNobodyHint, "Giao người cho máy này ở trang Nhân viên", "Assign people on the Employees page" },

    { StrId::CaptureLookAhead, "Nhìn thẳng vào camera", "Look at the camera" },
    { StrId::CaptureTurnLeft, "Quay nhẹ sang trái", "Turn slightly left" },
    { StrId::CaptureTurnRight, "Quay nhẹ sang phải", "Turn slightly right" },
    { StrId::CaptureTurnBack, "Quay ngược lại", "Turn the other way" },
    { StrId::CaptureHold, "Giữ nguyên", "Hold still" },
    { StrId::CaptureNoSample, "Chưa lấy được mẫu", "No sample taken" },
    { StrId::CaptureAddedFmt, "Đã thêm %s", "Added %s" },
    { StrId::CaptureSpoofFmt, "Ảnh giả · %d/%d", "Not live · %d/%d" },
    { StrId::CaptureConfirm, "Xác nhận", "Done" },
    { StrId::CaptureRetry, "Thử lại", "Try again" },
    { StrId::CaptureQuit, "Thoát", "Exit" },
    { StrId::CaptureCancel, "Huỷ", "Cancel" },

    { StrId::PeopleEmpty, "Chưa có ai", "Nobody yet" },
    { StrId::PeopleTemplatesFmt, "%u mẫu", "%u samples" },
    { StrId::PeopleUnnamed, "Chưa đặt tên", "No name" },
    { StrId::PersonRetake, "Chụp lại mẫu", "Take new samples" },
    { StrId::PersonRemove, "Xoá khỏi máy này", "Remove from this kiosk" },
    { StrId::PersonConfirm, "Chạm lần nữa để xoá", "Tap again to remove" },
    { StrId::PersonNoRoom, "Cần có mạng để gửi thêm yêu cầu", "Needs a network to send more" },
    { StrId::EnrolRetake, "Chụp lại", "Retake" },
    { StrId::EnrolPrev, "Trang trước", "Previous" },
    { StrId::EnrolNext, "Trang sau", "Next" },
    { StrId::EnrolPageFmt, "%d-%d / %d", "%d-%d / %d" },

    { StrId::WifiScanning, "Đang quét…", "Scanning…" },
    { StrId::WifiNone, "Không thấy mạng nào", "No networks found" },
    { StrId::WifiJoining, "Đang nối…", "Joining…" },
    { StrId::WifiWrongPass, "Sai mật khẩu", "Bad password" },
    { StrId::WifiJoined, "Đã nối", "Connected" },
    { StrId::WifiSaved, "Đã lưu", "Saved" },
    { StrId::WifiPassword, "Mật khẩu", "Password" },
    { StrId::WifiJoin, "Nối", "Join" },
};

constexpr size_t kCount = sizeof(kRows) / sizeof(kRows[0]);

constexpr bool indexed_by_id()
{
    for (size_t i = 0; i < kCount; ++i) {
        if (kRows[i].id != (StrId)i) {
            return false;
        }
    }
    return true;
}

static_assert(kCount == (size_t)StrId::Count, "every StrId needs a row and every row an id");
static_assert(indexed_by_id(), "rows run in enum order, so an id indexes them");

Lang s_lang = Lang::Vi;

}  // namespace

const char *text(StrId id) noexcept
{
    const size_t at = (size_t)id;
    return at >= kCount ? "" : (s_lang == Lang::En ? kRows[at].en : kRows[at].vi);
}

void set_language(Lang lang) noexcept
{
    s_lang = lang < Lang::Count ? lang : Lang::Vi;
}

Lang language() noexcept
{
    return s_lang;
}

const char *language_code(Lang lang) noexcept
{
    return lang == Lang::En ? "en" : "vi";
}

const char *language_badge(Lang lang) noexcept
{
    return lang == Lang::En ? "EN" : "VI";
}

Lang language_of(const char *code) noexcept
{
    return code != nullptr && strcmp(code, "en") == 0 ? Lang::En : Lang::Vi;
}

}  // namespace ui
