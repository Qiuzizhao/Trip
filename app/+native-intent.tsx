// The native inbox reads the original Linking URL; Router must not treat dataUrl as a page.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return path.includes('tripfootprints://dataUrl=') ? '/' : path;
}
