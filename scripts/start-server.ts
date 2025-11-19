import { dirname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { Server, SpawnOptions, Subprocess } from "bun";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");
const fastapiDir = join(repoRoot, "servers", "fastapi");
const nextDir = join(repoRoot, "servers", "nextjs");
const isDev = process.argv.includes("--dev") || process.env.NODE_ENV === "development";
const canChangeKeys = process.env.CAN_CHANGE_KEYS !== "false";
const publicPort = Number(process.env.PORT ?? 3000);
const fastapiPort = Number(process.env.FASTAPI_PORT ?? 8000);
const nextInternalPort = Number(process.env.NEXT_SERVER_PORT ?? 3030);
const appMcpPort = Number(process.env.APP_MCP_PORT ?? 8001);
const shouldStartOllama = process.env.DISABLE_OLLAMA !== "true";
const appDataDir = process.env.APP_DATA_DIRECTORY ?? "/app_data";
const tempDir = process.env.TEMP_DIRECTORY ?? "/tmp/presenton";

process.env.APP_DATA_DIRECTORY = appDataDir;
process.env.TEMP_DIRECTORY = tempDir;
process.env.PORT = String(publicPort);
process.env.USER_CONFIG_PATH = join(appDataDir, "userConfig.json");
process.env.PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/chromium";

const ensureDirectory = (dir: string) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

ensureDirectory(appDataDir);
["images", "exports", "uploads", "fonts"].forEach((folder) =>
  ensureDirectory(join(appDataDir, folder))
);
ensureDirectory(dirname(process.env.USER_CONFIG_PATH));
ensureDirectory(tempDir);

const setupUserConfigFromEnv = () => {
  if (!canChangeKeys) {
    return;
  }

  let existingConfig: Record<string, string | undefined> = {};
  if (existsSync(process.env.USER_CONFIG_PATH)) {
    existingConfig = JSON.parse(readFileSync(process.env.USER_CONFIG_PATH, "utf8"));
  }

  if (!(["ollama", "openai", "google"].includes(String(existingConfig.LLM)))) {
    existingConfig.LLM = undefined;
  }

  const userConfig = {
    LLM: process.env.LLM ?? existingConfig.LLM,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? existingConfig.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? existingConfig.OPENAI_MODEL,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? existingConfig.GOOGLE_API_KEY,
    GOOGLE_MODEL: process.env.GOOGLE_MODEL ?? existingConfig.GOOGLE_MODEL,
    OLLAMA_URL: process.env.OLLAMA_URL ?? existingConfig.OLLAMA_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? existingConfig.OLLAMA_MODEL,
    ANTHROPIC_API_KEY:
      process.env.ANTHROPIC_API_KEY ?? existingConfig.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? existingConfig.ANTHROPIC_MODEL,
    CUSTOM_LLM_URL: process.env.CUSTOM_LLM_URL ?? existingConfig.CUSTOM_LLM_URL,
    CUSTOM_LLM_API_KEY:
      process.env.CUSTOM_LLM_API_KEY ?? existingConfig.CUSTOM_LLM_API_KEY,
    CUSTOM_MODEL: process.env.CUSTOM_MODEL ?? existingConfig.CUSTOM_MODEL,
    PEXELS_API_KEY: process.env.PEXELS_API_KEY ?? existingConfig.PEXELS_API_KEY,
    PIXABAY_API_KEY: process.env.PIXABAY_API_KEY ?? existingConfig.PIXABAY_API_KEY,
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER ?? existingConfig.IMAGE_PROVIDER,
    TOOL_CALLS: process.env.TOOL_CALLS ?? existingConfig.TOOL_CALLS,
    DISABLE_THINKING:
      process.env.DISABLE_THINKING ?? existingConfig.DISABLE_THINKING,
    EXTENDED_REASONING:
      process.env.EXTENDED_REASONING ?? existingConfig.EXTENDED_REASONING,
    WEB_GROUNDING: process.env.WEB_GROUNDING ?? existingConfig.WEB_GROUNDING,
    USE_CUSTOM_URL: process.env.USE_CUSTOM_URL ?? existingConfig.USE_CUSTOM_URL,
  };

  writeFileSync(process.env.USER_CONFIG_PATH, JSON.stringify(userConfig));
};

const processes: Subprocess[] = [];
const nonCriticalProcesses: Subprocess[] = [];
let activeServer: Server | null = null;
let shuttingDown = false;

const spawnProcess = (
  cmd: string[],
  options: Partial<SpawnOptions> & { critical?: boolean } = {}
) => {
  const processOptions: SpawnOptions = {
    cmd,
    stdout: "inherit",
    stderr: "inherit",
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
  };

  const child = Bun.spawn(processOptions);
  const collection = options.critical === false ? nonCriticalProcesses : processes;
  collection.push(child);
  child.exited.then((code) => {
    if (options.critical === false) {
      console.warn(`${cmd[0]} exited with code ${code}`);
      return;
    }

    console.error(`${cmd[0]} exited with code ${code}`);
    shutdown(typeof code === "number" ? code : 1);
  });
  return child;
};

const shutdown = (code = 0) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  activeServer?.stop();
  [...processes, ...nonCriticalProcesses].forEach((proc) => {
    try {
      proc.kill();
    } catch (error) {
      console.error("Failed to stop process", error);
    }
  });
  process.exit(code);
};

const startServers = () => {
  spawnProcess([
    "python3",
    "server.py",
    "--port",
    String(fastapiPort),
    "--reload",
    isDev ? "true" : "false",
  ], {
    cwd: fastapiDir,
  });

  spawnProcess(["python3", "mcp_server.py", "--port", String(appMcpPort)], {
    cwd: fastapiDir,
    critical: false,
  });

  if (shouldStartOllama) {
    try {
      spawnProcess(["ollama", "serve"], { critical: false });
    } catch (error) {
      console.warn("Failed to start ollama:", error);
    }
  }

  const nextArgs = isDev
    ? ["bunx", "next", "dev", "-p", String(nextInternalPort)]
    : ["bunx", "next", "start", "-p", String(nextInternalPort)];

  spawnProcess(nextArgs, {
    cwd: nextDir,
    env: {
      ...process.env,
      PORT: String(nextInternalPort),
      NODE_ENV: isDev ? "development" : "production",
    },
  });
};

const proxyRequest = async (req: Request, target: string) => {
  const requestUrl = new URL(req.url);
  const targetUrl = new URL(target);
  targetUrl.pathname = requestUrl.pathname;
  targetUrl.search = requestUrl.search;

  const headers = new Headers(req.headers);
  headers.set("host", targetUrl.host);
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));

  return fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
  });
};

const staticMappings = [
  { prefix: "/static/", directory: join(fastapiDir, "static") },
  { prefix: "/app_data/images/", directory: join(appDataDir, "images") },
  { prefix: "/app_data/exports/", directory: join(appDataDir, "exports") },
  { prefix: "/app_data/uploads/", directory: join(appDataDir, "uploads") },
  { prefix: "/app_data/fonts/", directory: join(appDataDir, "fonts") },
];

const serveStaticAsset = async (pathname: string) => {
  for (const mapping of staticMappings) {
    if (!pathname.startsWith(mapping.prefix)) {
      continue;
    }

    const relativePath = pathname.slice(mapping.prefix.length);
    const absolutePath = normalize(join(mapping.directory, relativePath));

    if (!absolutePath.startsWith(mapping.directory)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (file.type) {
      headers.set("Content-Type", file.type);
    }
    return new Response(file, { headers });
  }
  return null;
};

const handleRequest = async (req: Request) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  const staticResponse = await serveStaticAsset(pathname);
  if (staticResponse) {
    return staticResponse;
  }

  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return proxyRequest(req, `http://127.0.0.1:${fastapiPort}`);
  }

  if (pathname === "/openapi.json") {
    return proxyRequest(req, `http://127.0.0.1:${fastapiPort}`);
  }

  if (pathname.startsWith("/api/v1/")) {
    return proxyRequest(req, `http://127.0.0.1:${fastapiPort}`);
  }

  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return proxyRequest(req, `http://127.0.0.1:${appMcpPort}`);
  }

  return proxyRequest(req, `http://127.0.0.1:${nextInternalPort}`);
};

const runTask = async (cmd: string[], cwd: string) => {
  const task = Bun.spawn({
    cmd,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await task.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} exited with code ${code}`);
  }
};

const ensureNextDependencies = async () => {
  const nodeModulesDir = join(nextDir, "node_modules");
  if (existsSync(nodeModulesDir)) {
    return;
  }
  console.log("Installing Next.js dependencies with Bun...");
  await runTask(["bun", "install"], nextDir);
};

const ensureNextBuild = async () => {
  if (isDev) {
    return;
  }
  const buildDir = join(nextDir, ".next");
  if (existsSync(buildDir)) {
    return;
  }
  console.log("Building Next.js application...");
  await runTask(["bunx", "next", "build"], nextDir);
};

const bootstrap = async () => {
  await ensureNextDependencies();
  await ensureNextBuild();
  setupUserConfigFromEnv();
  startServers();

  activeServer = Bun.serve({
    port: publicPort,
    fetch: handleRequest,
  });

  console.log(`Presenton Bun gateway listening on port ${publicPort}`);
};

bootstrap().catch((error) => {
  console.error(error);
  shutdown(1);
});

const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
signals.forEach((signal) =>
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down...`);
    shutdown(0);
  })
);
