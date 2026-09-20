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
