declare module 's3rver' {
  interface Options { port?: number; address?: string; directory?: string; silent?: boolean; configureBuckets?: Array<{ name: string }> }
  export default class S3rver {
    constructor(opts: Options);
    run(): Promise<unknown>;
    close(): Promise<void>;
  }
}
