import * as React from "react";
import { cn } from "../../lib/utils.js";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      type={type}
      className={cn(
        "border-input bg-background flex h-8 w-full rounded-md border px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

export { Input };
