import path from "node:path";

export function resolveDockerHostWorkspacePath(
  cwd: string,
  defaultInstanceDir: string,
  hostWorkspacePath: string | null | undefined
) {
  const normalizedCwd = path.normalize(cwd);
  const normalizedDefaultDir = path.normalize(defaultInstanceDir);
  if (!hostWorkspacePath) return normalizedCwd;

  const relativePath = path.relative(normalizedDefaultDir, normalizedCwd);
  // Mapping the workspace root itself would expose every instance to one quota project.
  // Only descendants of the configured instance directory are safe to translate.
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return normalizedCwd;
  }
  return path.normalize(path.join(hostWorkspacePath, relativePath));
}
