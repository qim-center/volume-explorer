#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4173;
const MAX_PORT_ATTEMPTS = 10;
const SHOULD_OPEN_BY_DEFAULT = Boolean(process.stdout.isTTY) && process.env.CI !== "true";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(projectRoot, "dist/app");
const indexFile = join(appRoot, "index.html");

function printHelp() {
  console.log(`Usage: volume-explorer [source-url] [options]

Starts a local server for the packaged QIM Volume Explorer app.

Options:
  -p, --port <port>     Port to listen on (default: ${DEFAULT_PORT})
  -H, --host <host>     Host/interface to bind (default: 127.0.0.1)
  -s, --src <url>       Dataset URL to preload
      --scale <value>   Initial scale level, for example 0, 1, or last
      --hidden          Start with the controls panel hidden
      --turntable       Enable turntable mode, pausing while hovered
      --open            Open the browser after starting
      --no-open         Do not open the browser after starting
  -h, --help            Show this help message

Examples:
  volume-explorer
  volume-explorer https://public.qim.dk/escargot/escargot.zarr/
  volume-explorer --src https://example.org/sample.zarr --hidden --scale last`);
}

function readOptionValue(args, index, flag) {
  const nextValue = args[index + 1];
  if (!nextValue || nextValue.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return nextValue;
}

function parseArgs(args) {
  const options = {
    help: false,
    host: "127.0.0.1",
    hidden: false,
    open: SHOULD_OPEN_BY_DEFAULT,
    port: undefined,
    scale: undefined,
    src: undefined,
    turntable: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--hidden") {
      options.hidden = true;
      continue;
    }
    if (arg === "--turntable") {
      options.turntable = true;
      continue;
    }
    if (arg === "-p" || arg === "--port") {
      const value = readOptionValue(args, i, arg);
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      options.port = port;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      options.port = port;
      continue;
    }
    if (arg === "-H" || arg === "--host") {
      options.host = readOptionValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "-s" || arg === "--src") {
      if (options.src) {
        throw new Error("Source URL was provided more than once");
      }
      options.src = readOptionValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--src=")) {
      if (options.src) {
        throw new Error("Source URL was provided more than once");
      }
      options.src = arg.slice("--src=".length);
      continue;
    }
    if (arg === "--scale") {
      options.scale = readOptionValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--scale=")) {
      options.scale = arg.slice("--scale=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.src) {
      throw new Error("Source URL was provided more than once");
    }

    options.src = arg;
  }

  return options;
}

function normalizeDisplayHost(host) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }

  return host;
}

function getLaunchPath(options) {
  const params = new URLSearchParams();
  if (options.src) {
    params.set("src", options.src);
  }
  if (options.scale) {
    params.set("scale", options.scale);
  }
  if (options.hidden) {
    params.set("hidden", "true");
  }
  if (options.turntable) {
    params.set("turntable", "true");
  }

  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function resolveRequestPath(pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  return resolve(appRoot, relativePath);
}

async function getFilePath(pathname) {
  let filePath = resolveRequestPath(pathname);

  if (!filePath.startsWith(appRoot)) {
    return null;
  }

  try {
    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = join(filePath, "index.html");
    }
    return filePath;
  } catch {
    if (extname(pathname) === "") {
      return indexFile;
    }
    return null;
  }
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function startServer(options) {
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const filePath = await getFilePath(requestUrl.pathname);

    if (!filePath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] ?? "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Failed to read file");
    });
    stream.pipe(res);
  });

  const requestedPort = options.port ?? DEFAULT_PORT;
  const maxAttempts = options.port ? 1 : MAX_PORT_ATTEMPTS;
  let currentPort = requestedPort;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolvePromise(undefined);
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(currentPort, options.host);
      });

      return { port: currentPort, server };
    } catch (error) {
      if (error && error.code === "EADDRINUSE" && !options.port && attempt < maxAttempts - 1) {
        currentPort += 1;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Unable to listen on a port starting at ${requestedPort}`);
}

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(indexFile)) {
  exitWithError("Built app not found at dist/app. Run `npm run build` before starting from a local checkout.");
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  exitWithError(error instanceof Error ? error.message : "Failed to parse CLI arguments");
}

if (options.help) {
  printHelp();
  process.exit(0);
}

let activeServer;

try {
  const { port, server } = await startServer(options);
  activeServer = server;

  const host = normalizeDisplayHost(options.host);
  const launchUrl = new URL(getLaunchPath(options), `http://${host}:${port}`).toString();

  console.log(`QIM Volume Explorer is running at ${launchUrl}`);
  console.log(`Serving static assets from ${appRoot}`);

  if (options.open) {
    openBrowser(launchUrl);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to start the server";
  exitWithError(message);
}

function shutdown(signal) {
  if (!activeServer) {
    process.exit(0);
  }

  activeServer.close(() => {
    if (signal) {
      console.log(`\nStopped ${signal}.`);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
