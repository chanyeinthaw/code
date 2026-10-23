interface MarkdownFence {
  readonly marker: string;
  readonly openingLine: string;
}

const splitBoundary = (text: string, maxLength: number): number => {
  const window = text.slice(0, maxLength);
  const minimumSoftBreak = Math.floor(maxLength / 2);
  const paragraph = window.lastIndexOf("\n\n");
  const line = window.lastIndexOf("\n");
  const word = window.lastIndexOf(" ");
  let boundary =
    paragraph >= minimumSoftBreak
      ? paragraph + 2
      : line >= minimumSoftBreak
        ? line + 1
        : word >= minimumSoftBreak
          ? word + 1
          : maxLength;
  const previous = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary -= 1;
  return boundary;
};

const fenceAfter = (
  text: string,
  initial: MarkdownFence | undefined,
): MarkdownFence | undefined => {
  let fence = initial;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1] ?? "";
    const trailing = match[2] ?? "";
    if (!fence) {
      fence = { marker, openingLine: line };
    } else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      trailing.trim().length === 0
    ) {
      fence = undefined;
    }
  }
  return fence;
};

const closingFence = (fence: MarkdownFence): string => fence.marker;

/**
 * Splits at readable boundaries and keeps fenced Markdown code valid in every chunk.
 * Continued code blocks are closed and reopened with their original language tag.
 */
export const splitMessage = (text: string, maxLength: number): ReadonlyArray<string> => {
  if (!Number.isInteger(maxLength) || maxLength < 2)
    throw new RangeError("Message limit must be at least two characters");
  if (text.length <= maxLength) return [text];
  const chunks: Array<string> = [];
  let remaining = text;
  let activeFence: MarkdownFence | undefined;

  while (remaining.length > 0) {
    const prefix = activeFence ? `${activeFence.openingLine}\n` : "";
    let rawLength = Math.min(remaining.length, maxLength - prefix.length);
    if (rawLength <= 0) {
      // A pathological fence declaration can consume the whole message limit.
      // Fall back to raw splitting rather than producing an oversized message.
      const boundary = splitBoundary(remaining, maxLength);
      chunks.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary);
      activeFence = undefined;
      continue;
    }

    let boundary = rawLength === remaining.length ? rawLength : splitBoundary(remaining, rawLength);
    let raw = remaining.slice(0, boundary);
    let nextFence = fenceAfter(raw, activeFence);
    let suffix = nextFence ? `${raw.endsWith("\n") ? "" : "\n"}${closingFence(nextFence)}` : "";

    while (prefix.length + raw.length + suffix.length > maxLength && boundary > 1) {
      rawLength = Math.max(1, rawLength - (prefix.length + raw.length + suffix.length - maxLength));
      boundary = splitBoundary(remaining, rawLength);
      raw = remaining.slice(0, boundary);
      nextFence = fenceAfter(raw, activeFence);
      suffix = nextFence ? `${raw.endsWith("\n") ? "" : "\n"}${closingFence(nextFence)}` : "";
    }

    if (boundary === 0 || prefix.length + raw.length + suffix.length > maxLength) {
      // Preserve progress and the hard limit when a fence leaves no room for a Unicode character.
      boundary = splitBoundary(remaining, maxLength);
      chunks.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary);
      activeFence = undefined;
      continue;
    }
    chunks.push(`${prefix}${raw}${suffix}`);
    remaining = remaining.slice(boundary);
    activeFence = nextFence;
  }

  return chunks;
};
