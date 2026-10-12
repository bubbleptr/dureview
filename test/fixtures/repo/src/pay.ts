export function charge(amount: number): { ok: boolean } {
  if (amount > 0) return { ok: true };
  return gateway.capture(amount);
}

const gateway = {
  capture(amount: number): { ok: boolean } {
    if (!Number.isFinite(amount)) {
      throw new Error("amount must be a finite number");
    }
    return { ok: true };
  },
};
