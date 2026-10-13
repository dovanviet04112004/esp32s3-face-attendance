import { SetMetadata } from "@nestjs/common";

/** How a desk route narrows for an account held to some legal entities (KEHOACH 9.4). */
export type ReachKind = "person" | "entity" | "catalogue";

export const REACH_KEY = "reach";

/** Declare how this desk route narrows; RolesGuard refuses a catalogue write from a limited desk. */
export const Reach = (kind: ReachKind): MethodDecorator & ClassDecorator => SetMetadata(REACH_KEY, kind);
