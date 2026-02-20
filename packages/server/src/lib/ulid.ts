export { monotonicFactory } from 'ulidx';
import { monotonicFactory } from 'ulidx';

const monotonic = monotonicFactory();

export function generateUlid(): string {
  return monotonic();
}
