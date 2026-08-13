export interface ArchiveEntryInfo {
  name: string;
  isDirectory: boolean;
  attr?: number;
  isLink?: boolean;
}

const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMBOLIC_LINK = 0xa000;

export function isArchiveLink(entry: ArchiveEntryInfo): boolean {
  if (entry.isLink) return true;
  if (entry.attr === undefined) return false;

  const unixMode = entry.attr >>> 16;
  return (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMBOLIC_LINK;
}
