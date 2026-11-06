import * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}
const TableHeader = (p: React.ComponentProps<"thead">) => <thead {...p} className={cn("[&_tr]:border-b", p.className)} />;
const TableBody = (p: React.ComponentProps<"tbody">) => <tbody {...p} className={cn("[&_tr:last-child]:border-0", p.className)} />;
const TableRow = (p: React.ComponentProps<"tr">) => <tr {...p} className={cn("border-b transition-colors hover:bg-muted/50", p.className)} />;
const TableHead = (p: React.ComponentProps<"th">) => (
  <th {...p} className={cn("h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-muted-foreground", p.className)} />
);
const TableCell = (p: React.ComponentProps<"td">) => <td {...p} className={cn("whitespace-nowrap p-2 align-middle", p.className)} />;

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
