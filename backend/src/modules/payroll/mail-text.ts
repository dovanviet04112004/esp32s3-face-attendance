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
