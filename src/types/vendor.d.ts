declare module '*vendor/noble-hashes/sha2.js' {
  export const sha256: { create(): import('./transfer.js').IncrementalHash };
}
interface QRCode {
  addData(data: string, mode?: string): void;
  make(): void;
  createDataURL(cellSize?: number, margin?: number): string;
}
declare var qrcode: (version: number, correction: string) => QRCode;
