import type { Device, Release } from "@prisma/client";

/** What a publisher may put on the register; ASSETS waits for the kiosk to install it (KEHOACH 7.7). */
export const PUBLISHED_TARGETS = ["FIRMWARE", "MODELS"] as const;
export type PublishedTarget = (typeof PUBLISHED_TARGETS)[number];

export const RELEASE_PUBLISHED = "release.published";
export const UPDATE_FINISHED = "release.update-finished";

export interface ReleasePublished {
  releaseId: string;
}

export interface UpdateFinished {
  deviceId: string;
  actorId: string;
  firmware: string;
  models: string;
}

export function semver(version: string | null): [number, number, number] | null {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : null;
}

/** Whether a kiosk runs something older than the release; a version it cannot state counts as older. */
export function behind(device: Pick<Device, "fwVersion" | "modelVersion">, release: Pick<Release, "target" | "version">): boolean {
  if (release.target === "MODELS") {
    return device.modelVersion !== release.version;
  }
  const mine = semver(device.fwVersion);
  const theirs = semver(release.version);
  if (!mine || !theirs) {
    return true;
  }
  for (let part = 0; part < 3; part += 1) {
    if (mine[part] !== theirs[part]) {
      return mine[part] < theirs[part];
    }
  }
  return false;
}

/** Whether installing the release moves the kiosk to another recognition model; a side that cannot say counts as moving. */
export function changesRecognition(
  device: Pick<Device, "embeddingVersion">,
  release: Pick<Release, "target" | "embeddingVersion">,
): boolean {
  return release.target === "MODELS" && (release.embeddingVersion === null || release.embeddingVersion !== device.embeddingVersion);
}
