/** The kind of thing an entry acts on; with an id it is what tracing runs
 *  from (KEHOACH 9.24 rule 3). */
export const AUDIT_SUBJECTS = {
  EMPLOYEE: "employee",
  USER: "user",
  PAYROLL: "payroll",
  ADVANCE: "advance",
  ASSET: "asset",
  ORG: "org",
  POLICY: "policy",
  LEAVE_TYPE: "leaveType",
  JOB_TITLE: "jobTitle",
  LEGAL_ENTITY: "legalEntity",
  DEPARTMENT: "department",
  ALLOWANCE_TYPE: "allowanceType",
  CHECKLIST_TEMPLATE: "checklistTemplate",
  DOCUMENT: "document",
  DEVICE: "device",
  RELEASE: "release",
  ROUTE: "route",
} as const;

export type AuditSubject = (typeof AUDIT_SUBJECTS)[keyof typeof AUDIT_SUBJECTS];

/** Every name the trail may carry; `AuditEntry.action` takes this type, so a
 *  string typed at a call site is a compile error (KEHOACH 9.24 rule 2). */
export const AUDIT_ACTIONS = {
  EMPLOYEE_CREATE: "employee.create",
  EMPLOYEE_UPDATE: "employee.update",
  EMPLOYEE_DEACTIVATE: "employee.deactivate",
  EMPLOYEE_ONBOARD: "employee.onboard",
  EMPLOYEE_OFFBOARD: "employee.offboard",
  EMPLOYEE_LEAVING_MOVE: "employee.leavingMove",
  EMPLOYEE_LEAVING_CANCEL: "employee.leavingCancel",

  USER_CREATE: "user.create",
  USER_ROLE: "user.role",
  USER_INVITE: "user.invite",
  USER_DELETE: "user.delete",
  USER_LOCKED: "user.locked",
  USER_LOCK: "user.lock",
  USER_UNLOCK: "user.unlock",
  USER_EMAIL: "user.email",
  USER_EMPLOYEE: "user.employee",

  CONTRACT_CREATE: "contract.create",
  CONTRACT_DECIDE: "contract.decide",

  PAY_CREATE: "pay.create",
  PAY_BULK_RAISE: "pay.bulkRaise",
  DEPENDENT_APPROVE: "dependent.approve",
  DEPENDENT_REJECT: "dependent.reject",

  PAYROLL_RUN: "payroll.run",
  PAYROLL_LOCK: "payroll.lock",
  PAYROLL_PAID: "payroll.paid",
  PAYROLL_QUEUE: "payroll.queue",
  PAYROLL_DELIVER: "payroll.deliver",
  PAYROLL_SETTLEMENT: "payroll.settlement",
  PAYROLL_BONUS: "payroll.bonus",

  TIMESHEET_CORRECT: "timesheet.correct",

  ADVANCE_APPROVE: "advance.approve",
  ADVANCE_REJECT: "advance.reject",
  ADVANCE_PAY: "advance.pay",

  DOCUMENT_CREATE: "document.create",
  DOCUMENT_PUBLISH: "document.publish",
  DOCUMENT_ACK: "document.ack",
  DOCUMENT_UPDATE: "document.update",
  FILE_TYPE_CREATE: "fileType.create",
  FILE_TYPE_UPDATE: "fileType.update",
  FILE_RECEIVE: "file.receive",

  ASSET_CREATE: "asset.create",
  ASSET_UPDATE: "asset.update",
  ASSET_ISSUE: "asset.issue",
  ASSET_RETURN: "asset.return",

  BIOMETRIC_CONSENT_GRANT: "biometric.consent.grant",
  BIOMETRIC_CONSENT_WITHDRAW: "biometric.consent.withdraw",
  BIOMETRIC_ERASE: "biometric.erase",
  BIOMETRIC_READ: "biometric.read",
  ENROLLMENT_ASSIGN: "enrollment.assign",
  ENROLLMENT_RETAKE: "enrollment.retake",
  ENROLLMENT_REMOVE: "enrollment.remove",

  ORG_REORG: "org.reorg",
  ORG_HOLIDAY_CREATE: "org.holidayCreate",
  ORG_HOLIDAY_UPDATE: "org.holidayUpdate",
  ORG_HOLIDAY_DELETE: "org.holidayDelete",

  JOB_TITLE_CREATE: "jobTitle.create",
  JOB_TITLE_UPDATE: "jobTitle.update",
  LEGAL_ENTITY_CREATE: "legalEntity.create",
  LEGAL_ENTITY_UPDATE: "legalEntity.update",
  DEPARTMENT_CREATE: "department.create",
  DEPARTMENT_UPDATE: "department.update",
  ALLOWANCE_TYPE_CREATE: "allowanceType.create",
  ALLOWANCE_TYPE_UPDATE: "allowanceType.update",
  CHECKLIST_TEMPLATE_CREATE: "checklistTemplate.create",
  CHECKLIST_TEMPLATE_UPDATE: "checklistTemplate.update",

  LEAVE_TYPE_CREATE: "leaveType.create",
  LEAVE_TYPE_UPDATE: "leaveType.update",

  CERTIFICATE_ASK: "certificate.ask",
  CERTIFICATE_ISSUE: "certificate.issue",
  CERTIFICATE_REJECT: "certificate.reject",
  CERTIFICATE_READ: "certificate.read",

  PROFILE_ASK: "profile.ask",
  PROFILE_APPROVE: "profile.approve",
  PROFILE_REJECT: "profile.reject",
  PROFILE_CANCEL: "profile.cancel",

  DISPUTE_RAISE: "dispute.raise",
  DISPUTE_ANSWER: "dispute.answer",
  DISPUTE_WITHDRAW: "dispute.withdraw",

  POLICY_CREATE: "policy.create",

  DEVICE_REGISTER: "device.register",
  DEVICE_TOKEN_ISSUE: "device.tokenIssue",
  DEVICE_RESET: "device.reset",
  DEVICE_APPROVE: "device.approve",
  DEVICE_REVOKE: "device.revoke",

  RELEASE_PUBLISH: "release.publish",
  RELEASE_OFFER: "release.offer",

  SHIFT_ASSIGN: "shift.assign",

  ROUTE_WRITE: "route.write",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
