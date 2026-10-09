import { notFound } from "next/navigation";

/** Any address no route answers, sent to the system's own not-found page in the reader's language (KEHOACH 9.21.6). */
export default function UnknownPage() {
  notFound();
}
