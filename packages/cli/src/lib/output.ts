export function printSuccess(message: string): void {
  console.log(`\u2713 ${message}`);
}

export function printError(message: string): void {
  console.error(`\u2717 ${message}`);
}

export function printInfo(label: string, value: string): void {
  console.log(`  ${label}: ${value}`);
}
