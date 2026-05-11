const noop = () => {};

const isSilent = false;

export const logUtil = {
  log: isSilent ? noop : console.log.bind(console),
  info: isSilent ? noop : console.info.bind(console),
  warn: isSilent ? noop : console.warn.bind(console),
  error: isSilent ? noop : console.error.bind(console),
};
