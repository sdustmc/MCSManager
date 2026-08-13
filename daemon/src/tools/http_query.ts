export function parseBooleanQuery(value: unknown, defaultValue = false): boolean {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  if (typeof normalizedValue === "boolean") return normalizedValue;
  if (typeof normalizedValue === "number") return normalizedValue === 1;
  if (typeof normalizedValue !== "string") return defaultValue;

  switch (normalizedValue.trim().toLowerCase()) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
    case "":
      return false;
    default:
      return defaultValue;
  }
}
