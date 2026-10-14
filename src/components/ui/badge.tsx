import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        pass: "border-transparent bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300",
        suggest: "border-transparent bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300",
        blocker: "border-transparent bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300",
        error: "border-transparent bg-muted text-muted-foreground",
        running: "border-transparent bg-sky-50 text-sky-800 dark:bg-sky-400/10 dark:text-sky-300",
        outline: "text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
