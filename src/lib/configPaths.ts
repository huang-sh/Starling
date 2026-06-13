import { extname } from "path";

export function hasKnownConfigExtension(fileName: string, extensions: readonly string[]): boolean {
  const extension = extname(fileName).toLowerCase();
  return extension.length > 0 && extensions.includes(extension);
}

