import { currentLocale } from './index.js';
export function numberLabel(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits }).format(value);
}
export function sizeLabel(bytes: number): string {
  const index = bytes < 1024 ? 0 : bytes < 1048576 ? 1 : bytes < 1073741824 ? 2 : 3;
  return `${numberLabel(bytes / (1024 ** index), index ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB'][index]}`;
}
export function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
