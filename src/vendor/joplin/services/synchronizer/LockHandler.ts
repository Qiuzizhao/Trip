// 本地替身：只保留 file-api.ts 用到的枚举与类型，源码抄自上游 LockHandler.ts:9-27。
// 我们的同步目标 supportsLocks = false，因此这些锁方法不会被调用。
export enum LockType {
  None = 0,
  Sync = 1,
  Exclusive = 2,
}

export enum LockClientType {
  Desktop = 1,
  Mobile = 2,
  Cli = 3,
}

export interface Lock {
  id?: string;
  type: LockType;
  clientType: LockClientType;
  clientId: string;
  updatedTime?: number;
}
