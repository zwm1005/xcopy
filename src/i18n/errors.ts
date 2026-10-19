import zh from './zh-CN.js';
import en from './en.js';
import { translate } from './index.js';
import { isMessageKey } from './messages.js';
import type { MessageDescriptor, MessageParams } from './messages.js';
// Only system messages enter this function. Device names, filenames and user text never do.
export function describeMessage(message: string): MessageDescriptor {
  for (const dictionary of [zh, en]) {
    for (const [messageKey, pattern] of Object.entries(dictionary)) {
      if (pattern === message) {
        return { messageKey, message };
      }
      if (!pattern.includes('{')) {
        continue;
      }
      const names: string[] = [];
      const expression = pattern.split(/(\{\w+\})/).map(part => {
        if (/^\{\w+\}$/.test(part)) {
          names.push(part.slice(1, -1));
          return '(.+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      const match = new RegExp(`^${expression}$`).exec(message);
      if (match) {
        return { messageKey, messageParams: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])), message };
      }
    }
  }
  return { message };
}
export function messageText(message = '', messageKey?: string, messageParams?: MessageParams): string {
  if (!message) {
    return '';
  }
  const descriptor = messageKey && isMessageKey(messageKey) ? { messageKey, messageParams } : describeMessage(message);
  return translate(descriptor.messageKey || '', descriptor.messageParams);
}
export class RemoteError extends Error {
  constructor(public code: string, private descriptor: MessageDescriptor) {
    super(descriptor.message);
    Object.defineProperty(this, 'message', { get: () => messageText(descriptor.message, descriptor.messageKey, descriptor.messageParams) });
  }
}
