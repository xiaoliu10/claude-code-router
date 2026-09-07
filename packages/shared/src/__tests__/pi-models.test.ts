import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  applyPiProjectTakeover,
  disableClient,
  enableClient,
  getContextWindow,
  getPiProjectProviderName,
  removePiProjectTakeover,
} from "../client-integrations";
import { CCR_PROJECT_HEADER, getClaudeProjectId } from "../constants";

const tempDirs: string[] = [];

function createFixture(): { piDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ccr-pi-models-"));
  tempDirs.push(root);
  return {
    piDir: join(root, "pi"),
    projectDir: join(root, "project"),
  };
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi managed models", () => {
  it("exports the shared context window resolver", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200000);
    expect(getContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow({ ContextWindow: "350000" })).toBe(350000);
  });

  it("removes [1m] from family aliases while preserving contextWindow", () => {
    const { piDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 3456,
      ContextWindow: 420000,
      Router: {
        families: {
          opus: { default: "provider,opus", enableExtendedContext: true },
          sonnet: { default: "provider,sonnet", enableExtendedContext: false },
        },
      },
      Clients: {
        pi: {
          configPath: piDir,
          modelAlias: "ccr-opus[1m]",
        },
      },
    };

    enableClient(config, "pi");

    const models = readJson(join(piDir, "models.json")).providers.ccr.models;
    expect(models.map((model: any) => model.id)).toEqual(["ccr-opus", "ccr-sonnet"]);
    expect(models.every((model: any) => model.contextWindow === 420000)).toBe(true);
    expect(readJson(join(piDir, "settings.json")).defaultModel).toBe("ccr-opus");
  });

  it("removes [1m] from the fallback alias", () => {
    const { piDir } = createFixture();
    const config = {
      ContextWindow: 260000,
      Clients: {
        pi: {
          configPath: piDir,
          modelAlias: "ccr-sonnet[1m]",
        },
      },
    };

    enableClient(config, "pi");

    const provider = readJson(join(piDir, "models.json")).providers.ccr;
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]).toMatchObject({
      id: "ccr-sonnet",
      contextWindow: 260000,
    });
    expect(readJson(join(piDir, "settings.json")).defaultModel).toBe("ccr-sonnet");
  });

  it("keeps managed refresh idempotent when generated content is unchanged", async () => {
    const { piDir, projectDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 3456,
      ContextWindow: 300000,
      Router: {
        families: {
          opus: { default: "provider,opus", enableExtendedContext: true },
        },
      },
      Clients: {
        pi: { configPath: piDir },
      },
    };

    applyPiProjectTakeover(projectDir, config);
    const modelsPath = join(piDir, "models.json");
    const settingsPath = join(projectDir, ".pi", "settings.json");
    const initialModelsMtime = statSync(modelsPath).mtimeMs;
    const initialSettingsMtime = statSync(settingsPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    applyPiProjectTakeover(projectDir, config);

    expect(statSync(modelsPath).mtimeMs).toBe(initialModelsMtime);
    expect(statSync(settingsPath).mtimeMs).toBe(initialSettingsMtime);
  });

  it("registers a dedicated project provider carrying the managed project id", () => {
    const { piDir, projectDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 4567,
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };

    applyPiProjectTakeover(projectDir, config);

    const providerName = getPiProjectProviderName(projectDir);
    const settings = readJson(join(projectDir, ".pi", "settings.json"));
    const provider = readJson(join(piDir, "models.json")).providers[providerName];
    expect(settings).toMatchObject({
      defaultProvider: providerName,
      defaultModel: "ccr-opus",
    });
    expect(provider).toMatchObject({
      baseUrl: "http://127.0.0.1:4567",
      headers: {
        [CCR_PROJECT_HEADER]: getClaudeProjectId(projectDir),
      },
    });
  });

  it("preserves dedicated project providers when global Pi takeover is disabled", () => {
    const { piDir, projectDir } = createFixture();
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "models.json"), JSON.stringify({
      providers: { official: { name: "Official" } },
    }));
    writeFileSync(join(piDir, "settings.json"), JSON.stringify({
      defaultProvider: "official",
      defaultModel: "official-model",
    }));
    const config = {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };

    enableClient(config, "pi");
    applyPiProjectTakeover(projectDir, config);
    const projectProvider = getPiProjectProviderName(projectDir);
    disableClient(config, "pi");

    const models = readJson(join(piDir, "models.json"));
    expect(Object.keys(models.providers).sort()).toEqual(["official", projectProvider].sort());
    expect(models.providers[projectProvider].headers[CCR_PROJECT_HEADER]).toBe(
      getClaudeProjectId(projectDir)
    );
    expect(readJson(join(piDir, "settings.json"))).toMatchObject({
      defaultProvider: "official",
      defaultModel: "official-model",
    });
  });

  it("removes only the provider owned by the disabled project takeover", () => {
    const { piDir, projectDir } = createFixture();
    const otherProject = join(projectDir, "other");
    const config = {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };
    applyPiProjectTakeover(projectDir, config);
    applyPiProjectTakeover(otherProject, config);

    removePiProjectTakeover(projectDir, config);

    const providers = readJson(join(piDir, "models.json")).providers;
    expect(providers[getPiProjectProviderName(projectDir)]).toBeUndefined();
    expect(providers[getPiProjectProviderName(otherProject)]).toBeDefined();
  });

  it("does not treat another project's provider as this project's takeover", () => {
    const { piDir, projectDir } = createFixture();
    const otherProject = join(projectDir, "other");
    const config = {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };
    applyPiProjectTakeover(otherProject, config);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({
      defaultProvider: getPiProjectProviderName(otherProject),
      defaultModel: "ccr-opus",
    }));

    removePiProjectTakeover(projectDir, config);

    const settings = readJson(join(projectDir, ".pi", "settings.json"));
    const providers = readJson(join(piDir, "models.json")).providers;
    expect(settings.defaultProvider).toBe(getPiProjectProviderName(otherProject));
    expect(providers[getPiProjectProviderName(otherProject)]).toBeDefined();
  });
});
