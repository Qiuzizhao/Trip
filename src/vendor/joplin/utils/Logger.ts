// 本地替身：上游来自 @joplin/utils/Logger 包。
// file-api.ts 同时用到 Logger.create()、new Logger() 和 Logger 作为类型，所以这里必须是 class。
type LogFn = (...args: unknown[]) => void;

export default class Logger {
  private prefix_: string;

  public constructor(name = 'joplin') {
    this.prefix_ = `[${name}]`;
  }

  public static create(name: string) {
    return new Logger(name);
  }

  public debug: LogFn = (...args) => { console.debug(this.prefix_, ...args); };
  public info: LogFn = (...args) => { console.log(this.prefix_, ...args); };
  public warn: LogFn = (...args) => { console.warn(this.prefix_, ...args); };
  public error: LogFn = (...args) => { console.error(this.prefix_, ...args); };
}

export type LoggerWrapper = Logger;
