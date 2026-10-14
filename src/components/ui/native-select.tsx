import * as React from "react";
import { cn } from "../../lib/utils.js";

function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input bg-background h-8 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
