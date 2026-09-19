import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names so a later one wins over an earlier one of the same kind. */
export function cn(...parts: ClassValue[]): string {
  return twMerge(clsx(parts));
}
