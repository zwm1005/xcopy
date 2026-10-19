import { messageKeys } from './message-keys.js';
export function messageDescriptor(message, prefix = 'message') {
  if (!message) {
    return {};
  }
  let key = messageKeys[message];
  let params;
  if (!key) {
    const match = /^无法建立 P2P 直连，服务器中转单个文件不能超过 ([0-9.]+) MB；请更换网络后重试$/.exec(message);
    if (match) {
      key = messageKeys['无法建立 P2P 直连，服务器中转单个文件不能超过 {p0} MB；请更换网络后重试'];
      params = { p0: Number(match[1]) };
    }
  }
  return key ? { [`${prefix}Key`]: key, ...(params ? { [`${prefix}Params`]: params } : {}) } : {};
}
