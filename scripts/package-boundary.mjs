const PI_HOST_PACKAGES = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

export function isPiHostPackage(name) {
  return PI_HOST_PACKAGES.has(name);
}
