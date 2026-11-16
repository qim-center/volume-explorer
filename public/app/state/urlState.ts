import type { CameraMode } from "./stateService";

export type Range = [number, number];
export type ScaleParam = number | "last";

interface Codec<T> {
  parse(raw: string): T | undefined;
  format(value: T): string;
}

const number: Codec<number> = {
  parse: (raw) => (raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined),
  format: (value) => String(Number(value.toPrecision(6))),
};

const integer = (min: number, max = Infinity): Codec<number> => ({
  parse: (raw) => {
    const value = number.parse(raw);
    return value !== undefined && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
  },
  format: String,
});

const flag: Codec<boolean> = {
  parse: (raw) => (raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : undefined),
  format: (value) => (value ? "1" : "0"),
};

const text: Codec<string> = {
  parse: (raw) => raw.trim() || undefined,
  format: (value) => value,
};

const oneOf = <T extends string>(values: T[]): Codec<T> => ({
  parse: (raw) => values.find((value) => value.toLowerCase() === raw.toLowerCase()),
  format: (value) => value.toLowerCase(),
});

const list = <T>(item: Codec<T>, lengths: number[]): Codec<T[]> => ({
  parse: (raw) => {
    const values = raw.split(",").map(item.parse);
    return lengths.includes(values.length) && !values.includes(undefined) ? (values as T[]) : undefined;
  },
  format: (values) => values.map(item.format).join(","),
});

const range = (item: Codec<number>): Codec<Range> => ({
  parse: (raw) => {
    const parts = raw.split(":");
    const [lo, hi] = parts.map(item.parse);
    return parts.length === 2 && lo !== undefined && hi !== undefined && lo <= hi ? [lo, hi] : undefined;
  },
  format: ([lo, hi]) => `${item.format(lo)}:${item.format(hi)}`,
});

const hexColor: Codec<string> = {
  parse: (raw) => (/^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toLowerCase()}` : undefined),
  format: (value) => value.replace("#", ""),
};

const scale: Codec<ScaleParam> = {
  parse: (raw) => (raw === "last" ? "last" : integer(0).parse(raw)),
  format: String,
};

const DATA = {
  src: text,
  scale,
};

const VIEW = {
  view: oneOf<CameraMode>(["3D", "X", "Y", "Z", "ORTHO"]),
  slice: list(integer(0), [1, 3]), 
  crop: list(range(integer(0)), [3]), 
  cam: list(number, [9, 10]), 
  colormap: text,
  invert: flag,
  cmrange: range(integer(0, 255)),
  cmlock: flag,
  transparency: range(number),
  opacity: integer(0, 100),
  grid: flag,
  bg: hexColor,
};

const LAUNCH = {
  turntable: flag,
  maxActiveRequests: integer(1),
};

type Codecs = Record<string, Codec<any>>;
type Values<C> = { [K in keyof C]?: C[K] extends Codec<infer T> ? T : never };

export type DataParams = Values<typeof DATA>;
export type ViewParams = Values<typeof VIEW>;

function parse<C extends Codecs>(codecs: C, params: URLSearchParams, invalid: string[]): Values<C> {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(codecs)) {
    const raw = params.get(key);
    const value = raw === null ? undefined : codecs[key].parse(raw);
    if (value !== undefined) {
      values[key] = value;
    } else if (raw !== null) {
      invalid.push(key);
    }
  }
  return values as Values<C>;
}

export function readUrlParams(search = window.location.search) {
  const params = new URLSearchParams(search);
  const invalid: string[] = [];
  return {
    data: parse(DATA, params, invalid),
    view: parse(VIEW, params, invalid),
    launch: parse(LAUNCH, params, invalid),
    invalid,
  };
}

const toQuery = (entries: string[][]): string =>
  entries.length === 0
    ? ""
    : "?" +
      entries
        .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%(3A|2F|2C)/gi, decodeURIComponent)}`)
        .join("&");

const format = <C extends Codecs>(codecs: C, values: Values<C>): string[][] =>
  Object.keys(codecs)
    .filter((key) => values[key] !== undefined)
    .map((key) => [key, codecs[key].format(values[key])]);

export function updateAddressBar(changes: DataParams): void {
  const others: string[][] = [];
  new URLSearchParams(window.location.search).forEach((value, key) => {
    if (!(key in DATA) && !(key in VIEW)) {
      others.push([key, value]);
    }
  });
  const data = { ...readUrlParams().data, ...changes };
  const query = toQuery([...format(DATA, data), ...others]);
  window.history.replaceState(null, "", window.location.pathname + query + window.location.hash);
}

export function buildViewLink(data: DataParams, view: ViewParams): string {
  const query = toQuery([...format(DATA, data), ...format(VIEW, view)]);
  return window.location.origin + window.location.pathname + query;
}
