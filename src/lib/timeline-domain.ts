export function domainAroundAnchor(
  anchor: number,
  span: number,
  anchorRatio: number,
): [start: number, end: number] {
  const start = anchor - span * anchorRatio;
  return [start, start + span];
}
