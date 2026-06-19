const enabled = process.stdout.isTTY && process.env.NO_COLOR == null;
function wrap(open, close, value) {
    return enabled ? `${open}${value}${close}` : value;
}
export const ansi = {
    bold: (value) => wrap("\x1b[1m", "\x1b[22m", value),
    dim: (value) => wrap("\x1b[2m", "\x1b[22m", value),
    inverse: (value) => wrap("\x1b[7m", "\x1b[27m", value),
    red: (value) => wrap("\x1b[31m", "\x1b[39m", value),
    green: (value) => wrap("\x1b[32m", "\x1b[39m", value),
    yellow: (value) => wrap("\x1b[33m", "\x1b[39m", value),
    blue: (value) => wrap("\x1b[34m", "\x1b[39m", value),
    magenta: (value) => wrap("\x1b[35m", "\x1b[39m", value),
    cyan: (value) => wrap("\x1b[36m", "\x1b[39m", value),
    white: (value) => wrap("\x1b[37m", "\x1b[39m", value),
    gray: (value) => wrap("\x1b[90m", "\x1b[39m", value),
};
