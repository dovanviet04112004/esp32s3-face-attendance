"use client";

import { SkeletonLine as KumoSkeletonLine } from "@cloudflare/kumo";
import { useId } from "react";

const kShimmerS = 1.5;
const kDelaySteps = 5;

interface Props {
  /** Percent of the line's box, as Kumo takes it. */
  minWidth?: number;
  maxWidth?: number;
  minDuration?: number;
  maxDuration?: number;
  minDelay?: number;
  maxDelay?: number;
  blockHeight?: number | string;
  className?: string;
}

function spreadOf(id: string): number {
  let spread = 0;
  for (const char of id) {
    spread = (spread * 31 + char.charCodeAt(0)) % 9973;
  }
  return spread;
}

/** Kumo's SkeletonLine with its width and shimmer drawn from the element's id: Kumo draws them
 *  from Math.random while rendering, so the server and the browser paint different lines.
 */
export function SkeletonLine({
  minWidth = 30,
  maxWidth = 100,
  minDuration = kShimmerS,
  maxDuration = kShimmerS,
  minDelay = 0,
  maxDelay = 0.4,
  blockHeight,
  className,
}: Props) {
  const spread = spreadOf(useId());
  const width = minWidth + (spread % (maxWidth - minWidth + 1));
  const duration = (minDuration + maxDuration) / 2;
  const delay = minDelay + ((maxDelay - minDelay) * (spread % kDelaySteps)) / (kDelaySteps - 1);
  return (
    <KumoSkeletonLine
      minWidth={width}
      maxWidth={width}
      minDuration={duration}
      maxDuration={duration}
      minDelay={delay}
      maxDelay={delay}
      blockHeight={blockHeight}
      className={className}
    />
  );
}
