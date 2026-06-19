const enabled = process.stdout.isTTY && process.env.NO_COLOR == null;

function wrap(open: string, close: string, value: string): string {
  return enabled ? `${open}${value}${close}` : value;
}

export const ansi = {
  bold: (value: string) => wrap("\x1b[1m", "\x1b[22m", value),
  dim: (value: string) => wrap("\x1b[2m", "\x1b[22m", value),
  inverse: (value: string) => wrap("\x1b[7m", "\x1b[27m", value),
  red: (value: string) => wrap("\x1b[31m", "\x1b[39m", value),
  green: (value: string) => wrap("\x1b[32m", "\x1b[39m", value),
  yellow: (value: string) => wrap("\x1b[33m", "\x1b[39m", value),
  blue: (value: string) => wrap("\x1b[34m", "\x1b[39m", value),
  magenta: (value: string) => wrap("\x1b[35m", "\x1b[39m", value),
  cyan: (value: string) => wrap("\x1b[36m", "\x1b[39m", value),
  white: (value: string) => wrap("\x1b[37m", "\x1b[39m", value),
  gray: (value: string) => wrap("\x1b[90m", "\x1b[39m", value),
};
