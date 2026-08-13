export interface ChunkRange {
  start: number;
  end: number;
}

export function addChunkRange(ranges: ChunkRange[], start: number, end: number): void {
  if (start >= end) return;

  let index = 0;
  while (index < ranges.length && ranges[index].end < start) index++;

  let mergeStart = start;
  let mergeEnd = end;
  let removeCount = 0;

  while (
    index + removeCount < ranges.length &&
    ranges[index + removeCount].start <= mergeEnd
  ) {
    mergeStart = Math.min(mergeStart, ranges[index + removeCount].start);
    mergeEnd = Math.max(mergeEnd, ranges[index + removeCount].end);
    removeCount++;
  }

  ranges.splice(index, removeCount, { start: mergeStart, end: mergeEnd });
}

export function isChunkRangeFullyCovered(ranges: ChunkRange[], size: number): boolean {
  return (
    ranges.length === 1 &&
    ranges[0].start === 0 &&
    ranges[0].end === size
  );
}
