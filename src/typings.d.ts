declare module "*.png" {
  const value: string;
  export default value;
}

declare module "*.obj" {
  const value: string;
  export default value;
}

declare module "jsfive" {
  export class Group {
    readonly name: string;
    readonly keys: string[];
    get(path: string): Dataset | Group | null;
  }

  export class Dataset {
    readonly name: string;
    readonly shape: number[] | null;
    readonly dtype: string | unknown[];
    readonly attrs: Record<string, unknown>;
    readonly value: number[];
  }

  export class File extends Group {
    constructor(buffer: ArrayBuffer, filename?: string);
  }
}
