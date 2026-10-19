import zh from './zh-CN.js';
export type MessageKey = keyof typeof zh;
export type MessageParams = Record<string, string | number>;
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
export type MessageArgs<K extends MessageKey> = [Placeholders<(typeof zh)[K]>] extends [never] ? [] : [Record<Placeholders<(typeof zh)[K]>, string | number>];
export interface MessageDescriptor { messageKey?: string; messageParams?: MessageParams; message?: string }
export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(zh, value);
}
