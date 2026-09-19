import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

/** Link and router that keep the locale on the URL. Importing the ones from
 *  next/navigation instead drops a reader into Vietnamese mid-session.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
