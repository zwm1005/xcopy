// @ts-check
/** @param {unknown} value @returns {string} */
export function validDeviceName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const name = value.trim();
  return name.length > 0 && name.length <= 24 && !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : '';
}

