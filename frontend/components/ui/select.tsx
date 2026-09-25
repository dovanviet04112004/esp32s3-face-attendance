import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/cn";
import { field } from "./input";

export function Select({ className, ...rest }: ComponentPropsWithRef<"select">) {
  return <select className={cn(field, "pe-8", className)} {...rest} />;
}
