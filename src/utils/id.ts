export const createId = (prefix: string): string => {
  return `${prefix}-${crypto.randomUUID()}`;
};
