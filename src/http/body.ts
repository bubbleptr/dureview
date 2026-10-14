/** Read a request body, rejecting anything larger than `limit` bytes. */
export async function readRawBody(request: Request, limit: number): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0 || size > limit) {
      throw new Error("request body is too large");
    }
  }
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > limit) throw new Error("request body is too large");
  return raw;
}
