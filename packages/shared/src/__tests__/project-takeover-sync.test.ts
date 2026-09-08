import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getClaudeSettingsLocalPath,
  refreshCcrProjectTakeover,
  setProjectTakeover,
  setCcrTakeover,
  syncGlobalProjectTakeovers,
  writeProjectConfig,
} from "../projectConfig";
import { getProjectConfigDir } from "../constants";
import { getPiProjectProviderName } from "../client-integrations";

const projectPaths: string[] = [];

function createProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), "ccr-project-takeover-sync-"));
  projectPaths.push(projectPath);
  return projectPath;
}

function globalConfig(contextWindow = 400000): Record<string, any> {
  return {
    APIKEY: "global-key",
    PORT: 4567,
    ContextWindow: contextWindow,
    Router: {
      families: {
        opus: {
          default: "provider,global-opus",
          extendedContext: "provider,global-extended",
          enableExtendedContext: true,
        },
      },
    },
  };
}

function projectRouter(extended = false): Record<string, any> {
  return {
    enableFamilyRouting: true,
    families: {
      opus: {
        default: "provider,project-opus",
        ...(extended
          ? {
              extendedContext: "provider,project-extended",
              enableExtendedContext: true,
            }
          : {}),
      },
    },
  };
}

function readSettings(projectPath: string): Record<string, any> {
  return JSON.parse(readFileSync(getClaudeSettingsLocalPath(projectPath), "utf8"));
}

afterEach(() => {
  for (const projectPath of projectPaths.splice(0)) {
    rmSync(getProjectConfigDir(projectPath), { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});

describe("project takeover Router synchronization", () => {
  it("uses the authoritative project Router instead of the global family aliases", async () => {
    const projectPath = createProject();
    await writeProjectConfig(projectPath, { Router: projectRouter(false) });
    await setCcrTakeover(projectPath, true, globalConfig());

    const settings = readSettings(projectPath);
    expect(settings.env.ANTHROPIC_MODEL).toBe("ccr-opus");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("ccr-opus");
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4567");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("global-key");
  });

  it("refreshes a custom Router project immediately after its Router changes", async () => {
    const projectPath = createProject();
    await writeProjectConfig(projectPath, { Router: projectRouter(true) });
    await setCcrTakeover(projectPath, true, globalConfig());

    await writeProjectConfig(projectPath, { Router: projectRouter(false) });
    expect(await refreshCcrProjectTakeover(projectPath, globalConfig())).toBe(true);

    const settings = readSettings(projectPath);
    expect(settings.env.ANTHROPIC_MODEL).toBe("ccr-opus");
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
  });

  it("syncs global and custom Router projects without leaking global extended context", async () => {
    const globalProject = createProject();
    const customProject = createProject();
    await writeProjectConfig(globalProject, { Router: {} });
    await writeProjectConfig(customProject, { Router: projectRouter(false) });
    await setCcrTakeover(globalProject, true, globalConfig(300000));
    await setCcrTakeover(customProject, true, globalConfig(300000));

    const result = await syncGlobalProjectTakeovers(globalConfig(420000));

    expect(result).toMatchObject({ updated: 2, skipped: 0, failed: [] });
    expect(readSettings(globalProject).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("420000");
    expect(readSettings(globalProject).env.ANTHROPIC_MODEL).toBe("ccr-opus[1m]");
    expect(readSettings(customProject).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
    expect(readSettings(customProject).env.ANTHROPIC_MODEL).toBe("ccr-opus");
  });

  it("skips custom Router projects without Claude Code takeover", async () => {
    const projectPath = createProject();
    await writeProjectConfig(projectPath, { Router: projectRouter(false) });
    const qwenSettingsPath = join(projectPath, ".qwen", "settings.json");
    mkdirSync(join(projectPath, ".qwen"), { recursive: true });
    writeFileSync(qwenSettingsPath, JSON.stringify({ marker: "unchanged" }), {
      encoding: "utf8",
      flag: "w",
    });

    const before = readFileSync(qwenSettingsPath, "utf8");
    const result = await syncGlobalProjectTakeovers(globalConfig(420000));

    expect(result).toMatchObject({ updated: 0, skipped: 1, failed: [] });
    expect(readFileSync(qwenSettingsPath, "utf8")).toBe(before);
  });

  it("creates and refreshes Pi takeover from the authoritative project Router", async () => {
    const projectPath = createProject();
    const piDir = join(projectPath, "pi-agent");
    const config = {
      ...globalConfig(),
      Clients: { pi: { configPath: piDir } },
    };
    await writeProjectConfig(projectPath, { Router: projectRouter(false) });

    await setProjectTakeover(projectPath, ["pi"], config);

    const providerName = getPiProjectProviderName(projectPath);
    const projectSettings = JSON.parse(
      readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")
    );
    expect(projectSettings.defaultProvider).toBe(providerName);
    let provider = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8"))
      .providers[providerName];
    expect(provider.models.map((model: any) => model.id)).toEqual(["ccr-opus"]);

    const nextRouter = {
      enableFamilyRouting: true,
      families: {
        sonnet: { default: "provider,project-sonnet" },
      },
    };
    await writeProjectConfig(projectPath, { Router: nextRouter });
    const result = await syncGlobalProjectTakeovers(config);

    expect(result).toMatchObject({ updated: 1, skipped: 0, failed: [] });
    provider = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8"))
      .providers[providerName];
    expect(provider.models.map((model: any) => model.id)).toEqual(["ccr-sonnet"]);
    expect(JSON.parse(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")))
      .toMatchObject({ defaultProvider: providerName, defaultModel: "ccr-sonnet" });
  });

  it("migrates a legacy shared Pi provider when project takeovers are synchronized", async () => {
    const projectPath = createProject();
    const piDir = join(projectPath, "pi-agent");
    mkdirSync(join(projectPath, ".pi"), { recursive: true });
    writeFileSync(
      join(projectPath, ".pi", "settings.json"),
      JSON.stringify({ defaultProvider: "ccr", defaultModel: "ccr-opus" })
    );
    await writeProjectConfig(projectPath, { Router: projectRouter(false) });
    const config = {
      ...globalConfig(),
      Clients: { pi: { configPath: piDir } },
    };

    const result = await syncGlobalProjectTakeovers(config);

    expect(result).toMatchObject({ updated: 1, skipped: 0, failed: [] });
    expect(JSON.parse(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")))
      .toMatchObject({
        defaultProvider: getPiProjectProviderName(projectPath),
        defaultModel: "ccr-opus",
      });
  });
});
