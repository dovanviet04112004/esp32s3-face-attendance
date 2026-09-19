// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/enroll_payload.schema.json
// Regenerate: ./tools/gen_contracts.py

/** Face roster traffic in both directions. Server to kiosk pushes templates and assignments; kiosk to server reports what an operator did at the machine. Carries the int8 embedding and its dequant scale exactly as they land in the 552-byte record of KEHOACH 6.2.4. */
export interface EnrollPayload {
  /** DELETE removes one template, DELETE_EMPLOYEE removes every template of the employee, REPLACE_ALL is the full-resync path. ASSIGN names an employee the kiosk should expect to enroll and carries no embedding, REVOKE withdraws that expectation. */
  op: "UPSERT" | "DELETE" | "DELETE_EMPLOYEE" | "REPLACE_ALL" | "ASSIGN" | "REVOKE";
  employeeId: number;
  /** One employee holds several templates: frontal, glasses, low light. */
  templateIdx: number;
  /** Epoch milliseconds UTC. The kiosk keeps the newer of two conflicting pushes. */
  updatedAt: number;
  /** 512 int8 values, base64 of the raw bytes. Required for UPSERT. */
  embedding?: string;
  /** Dequant factor for embedding. Required for UPSERT. */
  scale?: number;
  /** Enrollment image quality; breaks ties when two templates collide. */
  quality?: number;
  /** Recognition model that produced the embedding. A kiosk running a different model must refuse the template rather than compare across models. */
  embeddingVersion?: string;
  /** Shown on the kiosk screen after a match. Display only. */
  fullName?: string;
  employeeCode?: string;
  /** Server to kiosk: the roster generation this device stands at once it has applied this op. The kiosk reports it back in every heartbeat, which is what lets the server push exactly what a machine missed while it was offline. */
  rosterVersion?: number;
  /** Kiosk to server only: which machine is reporting. */
  deviceId?: string;
}
