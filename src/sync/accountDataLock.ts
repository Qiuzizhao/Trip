import { Mutex } from 'async-mutex';

// Account changes wait for ongoing sync; queued sync reads the new session afterwards.
const accountDataLock = new Mutex();
export const withAccountDataLock = <T>(action: () => Promise<T>): Promise<T> =>
  accountDataLock.runExclusive(action);
