declare module 'http_ece' {
  const ece: { decrypt(buffer: Buffer, params: Record<string, unknown>): Buffer };
  export default ece;
}
