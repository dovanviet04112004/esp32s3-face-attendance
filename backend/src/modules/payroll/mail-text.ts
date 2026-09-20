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

const kDefault: MailLocale = "vi";

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
}

const SETUP: Record<MailLocale, (facts: SetupMailFacts) => MailBody> = {
  vi: (facts) => ({
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
      "Quá hạn thì nhờ bộ phận nhân sự phát lại, không ai đặt hộ mật khẩu được.",
    ].join("\n"),
  }),
  en: (facts) => ({
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
      "After that, ask HR to send a new one; nobody can set the password for you.",
    ].join("\n"),
  }),
};

export function setupMail(locale: string, facts: SetupMailFacts): MailBody {
  return SETUP[readsAs(locale)](facts);
}
