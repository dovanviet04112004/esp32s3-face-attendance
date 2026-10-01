-- The types of a shared item next to each reader's row (KEHOACH 9.21.4). A queue, a subject
-- or an outcome joins its enum in the migration of the first kind that uses it.
CREATE TYPE "NoticeQueue" AS ENUM (
  'REQUESTS', 'ADVANCES_TO_DECIDE', 'ADVANCES_TO_PAY', 'CERTIFICATES', 'PROFILE_CHANGES', 'DISPUTES', 'DEPENDENTS'
);

CREATE TYPE "NoticeSubject" AS ENUM (
  'REQUEST', 'ADVANCE', 'CERTIFICATE', 'PROFILE_CHANGE', 'DEPENDENT', 'DISPUTE', 'PAYSLIP', 'CONTRACT'
);

CREATE TYPE "NoticeOutcome" AS ENUM ('APPROVED', 'REJECTED', 'ISSUED', 'UPHELD', 'PAID');

CREATE TYPE "NoticeLevel" AS ENUM ('INFO', 'ACTION', 'WARNING', 'CRITICAL');

CREATE TYPE "NoticeItemState" AS ENUM ('OPEN', 'DONE', 'WITHDRAWN', 'EXPIRED', 'CLEARED');
