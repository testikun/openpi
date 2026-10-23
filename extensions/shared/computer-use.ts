/** Pi owns installation, resource selection, schemas and native execution. */
export const COMPUTER_USE_PACKAGE = {
  name: "@injaneity/pi-computer-use",
  version: "0.5.1",
  source: "npm:@injaneity/pi-computer-use@0.5.1",
  repository: "https://github.com/injaneity/pi-computer-use",
} as const;

export const COMPUTER_USE_ACTIONS = ["install", "disable"] as const;
export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];

export function isComputerUseSource(source: string) {
  return /^npm:@injaneity\/pi-computer-use(?:@[^/]+)?$/u.test(source);
}
