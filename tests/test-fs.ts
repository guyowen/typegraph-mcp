import fs from "node:fs";

/** Remove a test workspace after child compilers release their Windows handles. */
export function removeTempTree(directory: string): void {
  for (let attempt = 0; attempt <= 10; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 10 || !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(code ?? "")) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
}
