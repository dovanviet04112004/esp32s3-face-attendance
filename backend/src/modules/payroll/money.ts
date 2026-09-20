const kBasisPointScale = 10_000n;

/** A dong amount. Integer because the currency has no minor unit in practice. */
export type Dong = bigint;

export function mulDiv(amount: Dong, numerator: bigint, denominator: bigint): Dong {
  if (denominator === 0n) {
    return 0n;
  }
  const scaled = amount * numerator;
  const negative = scaled < 0n !== denominator < 0n;
  const top = scaled < 0n ? -scaled : scaled;
  const bottom = denominator < 0n ? -denominator : denominator;
  // Half away from zero, which is what a payslip reader expects of a rounding.
  const rounded = (top * 2n + bottom) / (bottom * 2n);
  return negative ? -rounded : rounded;
}

export function byBasisPoints(amount: Dong, basisPoints: number): Dong {
  return mulDiv(amount, BigInt(basisPoints), kBasisPointScale);
}

export function atMost(amount: Dong, ceiling: Dong): Dong {
  return amount > ceiling ? ceiling : amount;
}

export function atLeastZero(amount: Dong): Dong {
  return amount > 0n ? amount : 0n;
}

/** Prisma hands back a Decimal; its string form is the only lossless reading. */
export function toDong(value: { toString(): string } | null | undefined): Dong {
  if (value === null || value === undefined) {
    return 0n;
  }
  const text = value.toString();
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : text.slice(dot + 1);
  const rounded = BigInt(whole || "0");
  if (fraction === "" || Number(fraction[0]) < 5) {
    return rounded;
  }
  return rounded < 0n ? rounded - 1n : rounded + 1n;
}

/** Day counts arrive as Decimal(6,2); hundredths keep half-days exact. */
export function toHundredths(value: { toString(): string } | null | undefined): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  const text = value.toString();
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : `${text.slice(dot + 1)}00`.slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const magnitude = BigInt(whole.replace("-", "") || "0") * 100n + BigInt(fraction || "0");
  return sign * magnitude;
}
