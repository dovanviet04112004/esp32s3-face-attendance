import type { SetupReason } from "../../queue/queues.js";

export type MailLocale = "vi" | "en";

export interface PayslipMailFacts {
  fullName: string;
  month: number;
  year: number;
  url: string;
}

export interface MailBody {
  subject: string;
  text: string;
}

/** Mail carries no request, so an account with no record reads this one. */
export const DEFAULT_MAIL_LOCALE: MailLocale = "vi";

const kDefault = DEFAULT_MAIL_LOCALE;

/**
 * Mail is written on the server, where no request carries a language, so the
 * text lives here rather than in either client catalogue (KEHOACH 9.11).
 */
const PAYSLIP: Record<MailLocale, (facts: PayslipMailFacts) => MailBody> = {
  vi: (facts) => ({
    subject: `Phiếu lương tháng ${facts.month}/${facts.year}`,
    text: [
      `Chào ${facts.fullName},`,
      "",
      `Phiếu lương tháng ${facts.month}/${facts.year} của bạn đã có.`,
      "Mở đường dẫn dưới đây để xem chi tiết từng khoản:",
      "",
      facts.url,
      "",
      "Đường dẫn yêu cầu đăng nhập. Thư này không đính kèm phiếu lương.",
      "Nếu có khoản nào chưa đúng, gửi khiếu nại ngay trên trang đó.",
    ].join("\n"),
  }),
  en: (facts) => ({
    subject: `Payslip for ${facts.month}/${facts.year}`,
    text: [
      `Hello ${facts.fullName},`,
      "",
      `Your payslip for ${facts.month}/${facts.year} is ready.`,
      "Open the link below to see every component:",
      "",
      facts.url,
      "",
      "The link asks you to sign in. No payslip is attached to this message.",
      "If a figure looks wrong, raise it on that page.",
    ].join("\n"),
  }),
};

export function readsAs(locale: string): MailLocale {
  return locale === "en" ? "en" : kDefault;
}

export function payslipMail(locale: string, facts: PayslipMailFacts): MailBody {
  return PAYSLIP[readsAs(locale)](facts);
}

export interface SetupMailFacts {
  fullName: string;
  url: string;
  hours: number;
  reason: SetupReason;
}

const SETUP: Record<MailLocale, Record<SetupReason, (facts: SetupMailFacts) => MailBody>> = {
  vi: {
    opened: (facts) => ({
      subject: "Mở tài khoản chấm công của bạn",
      text: [
        `Chào ${facts.fullName},`,
        "",
        "Công ty đã mở cho bạn một tài khoản để xem công, phép và phiếu lương.",
        "Mở đường dẫn dưới đây để tự đặt mật khẩu:",
        "",
        facts.url,
        "",
        `Đường dẫn dùng được một lần và hết hạn sau ${facts.hours} giờ.`,
        "Quá hạn thì xin lại ở trang đăng nhập; không ai đặt hộ mật khẩu được.",
      ].join("\n"),
    }),
    forgot: (facts) => ({
      subject: "Đặt lại mật khẩu chấm công",
      text: [
        `Chào ${facts.fullName},`,
        "",
        "Có người vừa xin đặt lại mật khẩu cho tài khoản này.",
        "Nếu là bạn, mở đường dẫn dưới đây để chọn mật khẩu mới:",
        "",
        facts.url,
        "",
        `Đường dẫn dùng được một lần và hết hạn sau ${facts.hours} giờ.`,
        "Nếu không phải bạn thì bỏ qua thư này: mật khẩu đang dùng vẫn nguyên.",
      ].join("\n"),
    }),
  },
  en: {
    opened: (facts) => ({
      subject: "Your attendance account is open",
      text: [
        `Hello ${facts.fullName},`,
        "",
        "An account has been opened for you to see your attendance, leave and payslips.",
        "Open the link below to set your own password:",
        "",
        facts.url,
        "",
        `The link works once and expires in ${facts.hours} hours.`,
        "After that, ask for another from the sign-in page; nobody can set it for you.",
      ].join("\n"),
    }),
    forgot: (facts) => ({
      subject: "Set a new attendance password",
      text: [
        `Hello ${facts.fullName},`,
        "",
        "Somebody asked to set a new password for this account.",
        "If that was you, open the link below to choose one:",
        "",
        facts.url,
        "",
        `The link works once and expires in ${facts.hours} hours.`,
        "If it was not you, ignore this letter: the password you have still works.",
      ].join("\n"),
    }),
  },
};

export function setupMail(locale: string, facts: SetupMailFacts): MailBody {
  return SETUP[readsAs(locale)][facts.reason](facts);
}

export type NoticedChange = "BANK" | "PERSONAL_EMAIL";

export interface ProfileNoticeFacts {
  fullName: string;
  change: NoticedChange;
  decidedOn: string;
}

const CHANGED: Record<MailLocale, Record<NoticedChange, string>> = {
  vi: { BANK: "số tài khoản nhận lương", PERSONAL_EMAIL: "địa chỉ email liên lạc" },
  en: { BANK: "the account your pay goes to", PERSONAL_EMAIL: "your contact email address" },
};

/** The address this reaches may have gone stale enough to belong to somebody
 *  else, so it names what moved and never the new value (KEHOACH 9.17 item 6
 *  rule 3).
 */
const PROFILE: Record<MailLocale, (facts: ProfileNoticeFacts) => MailBody> = {
  vi: (facts) => ({
    subject: "Thông tin cá nhân của bạn vừa được đổi",
    text: [
      `Chào ${facts.fullName},`,
      "",
      `Ngày ${facts.decidedOn}, ${CHANGED.vi[facts.change]} trong hồ sơ của bạn`,
      "đã được đổi theo một đơn đã duyệt.",
      "",
      "Thư này không kèm giá trị mới và không cần trả lời.",
      "Nếu không phải bạn yêu cầu, báo ngay cho bộ phận nhân sự.",
    ].join("\n"),
  }),
  en: (facts) => ({
    subject: "Something in your record has changed",
    text: [
      `Hello ${facts.fullName},`,
      "",
      `On ${facts.decidedOn}, ${CHANGED.en[facts.change]} was changed`,
      "through an approved request.",
      "",
      "This message carries no new value and needs no reply.",
      "If you did not ask for it, tell HR straight away.",
    ].join("\n"),
  }),
};

export function profileNoticeMail(locale: string, facts: ProfileNoticeFacts): MailBody {
  return PROFILE[readsAs(locale)](facts);
}

export type BackupProblem = "WAL_FAILING" | "DUMP_STALE" | "BIOMETRIC_STALE" | "BASE_STALE" | "WAL_STALE";

export interface BackupAlarmFacts {
  problem: BackupProblem;
  checkedAt: string;
  lastGood: string | null;
  detail: string | null;
}

const BROKEN: Record<MailLocale, Record<BackupProblem, { title: string; what: string }>> = {
  vi: {
    WAL_FAILING: {
      title: "WAL không đẩy được",
      what: "Postgres không đẩy được segment WAL vào kho sao lưu, nên nó giữ lại mọi segment chưa đẩy: đĩa đầy dần tới khi cơ sở dữ liệu dừng.",
    },
    DUMP_STALE: {
      title: "bản logic chính cũ",
      what: "Bản sao lưu logic chính không có bản mới.",
    },
    BIOMETRIC_STALE: {
      title: "bản mẫu khuôn mặt cũ",
      what: "Bản sao lưu mẫu khuôn mặt không có bản mới.",
    },
    BASE_STALE: {
      title: "bản gốc vật lý cũ",
      what: "Bản gốc vật lý không có bản mới, nên không tua lại được tới những phút gần đây.",
    },
    WAL_STALE: {
      title: "đường WAL không tới kho",
      what: "Lượt thử đường WAL hằng đêm không thấy segment nào tới kho sao lưu.",
    },
  },
  en: {
    WAL_FAILING: {
      title: "WAL is not being archived",
      what: "Postgres cannot push WAL segments to the backup archive, so it keeps every one it could not push: the disk fills until the database stops.",
    },
    DUMP_STALE: {
      title: "the main logical dump is stale",
      what: "The main logical dump has no new copy.",
    },
    BIOMETRIC_STALE: {
      title: "the face template dump is stale",
      what: "The face template dump has no new copy.",
    },
    BASE_STALE: {
      title: "the physical base backup is stale",
      what: "The physical base backup has no new copy, so recent minutes cannot be replayed.",
    },
    WAL_STALE: {
      title: "WAL is not reaching the archive",
      what: "The nightly test of the WAL path saw no segment reach the backup archive.",
    },
  },
};

/** Sent to every active ADMIN and repeated daily until the check passes (KEHOACH 4.8 rule 5). */
const BACKUP_ALARM: Record<MailLocale, (facts: BackupAlarmFacts) => MailBody> = {
  vi: (facts) => ({
    subject: `Sao lưu cần xem ngay: ${BROKEN.vi[facts.problem].title}`,
    text: [
      `Lượt kiểm sao lưu lúc ${facts.checkedAt} thấy:`,
      BROKEN.vi[facts.problem].what,
      "",
      `Lần cuối ổn: ${facts.lastGood ?? "chưa từng"}.`,
      ...(facts.detail ? [`Chi tiết: ${facts.detail}`] : []),
      "",
      "Xem trên VPS: docker logs kiosk-postgres",
      "và docker exec kiosk-backup tail -n 50 /var/log/backup.log",
      "",
      "Thư này nhắc lại mỗi 24 giờ cho tới khi hết lỗi.",
    ].join("\n"),
  }),
  en: (facts) => ({
    subject: `Backups need a look now: ${BROKEN.en[facts.problem].title}`,
    text: [
      `The backup check at ${facts.checkedAt} found:`,
      BROKEN.en[facts.problem].what,
      "",
      `Last good: ${facts.lastGood ?? "never"}.`,
      ...(facts.detail ? [`Detail: ${facts.detail}`] : []),
      "",
      "Look on the VPS: docker logs kiosk-postgres",
      "and docker exec kiosk-backup tail -n 50 /var/log/backup.log",
      "",
      "This message repeats every 24 hours until the check passes.",
    ].join("\n"),
  }),
};

export function backupAlarmMail(locale: string, facts: BackupAlarmFacts): MailBody {
  return BACKUP_ALARM[readsAs(locale)](facts);
}
