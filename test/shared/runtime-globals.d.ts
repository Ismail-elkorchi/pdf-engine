declare const Deno: {
  readonly args: readonly string[];
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  readFile(path: URL | string): Promise<Uint8Array>;
  writeTextFile(path: string, value: string): Promise<void>;
  readonly stdout: { writeSync(data: Uint8Array): number };
  readonly stderr: { writeSync(data: Uint8Array): number };
  exit(code: number): never;
};

declare const Bun: {
  readonly argv: readonly string[];
  file(path: URL | string): {
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  write(path: string, value: string): Promise<unknown>;
};
