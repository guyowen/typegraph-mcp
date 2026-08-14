import fs from "node:fs";

/** Remove a test workspace after child compilers release their Windows handles. */
export function removeTempTree(directory: string): void {
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
