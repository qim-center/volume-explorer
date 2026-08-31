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
  
  export interface DataObjects {
    readonly fh: ArrayBuffer;
    find_msg_type(msgType: number): Map<string, number>[];
    _get_data_message_properties(msgOffset: number): [number, number, number, number];
    readonly filter_pipeline: unknown[] | null;
  }

  export class Dataset {
    readonly name: string;
    readonly shape: number[] | null;
    readonly dtype: string | unknown[];
    readonly attrs: Record<string, unknown>;
    readonly value: number[];
    readonly _dataobjects: DataObjects;
  }

  export class File extends Group {
    constructor(buffer: ArrayBuffer, filename?: string);
  }
}
