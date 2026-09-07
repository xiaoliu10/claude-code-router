import {
  applyClientSelection,
  CLIENT_IDS,
  disableClient,
  disableConfiguredClients,
  enableClient,
  enableConfiguredClients,
  isClientId,
  listClientStatuses,
  restoreClient,
  syncGlobalProjectTakeovers,
  type ClientApplyResult,
  type ClientId,
  type ClientOperationResult,
} from "@wengine-ai/claude-code-router-shared";
import { readConfigFile, writeConfigFile } from ".";

function printOperationResults(result: ClientApplyResult): void {
  for (const item of result.results) {
    if (!item.success) {
      console.error(`✗ ${item.id}: ${item.error || "operation failed"}`);
      continue;
    }

    const action = item.action === "enable" ? "enabled" : item.action === "restore" ? "restored" : "disabled";
    console.log(`✓ ${item.status?.name || item.id} ${action}`);
  }
}

export async function enableConfiguredClientsForStart(): Promise<void> {
  const config = await readConfigFile();
  const result = enableConfiguredClients(config);
  await writeConfigFile(result.config);
  await syncGlobalProjectTakeovers(result.config);

  if (!result.success) {
    printOperationResults(result);
  }
}

export async function disableConfiguredClientsForStop(): Promise<void> {
  const config = await readConfigFile();
  const result = disableConfiguredClients(config);
  await writeConfigFile(result.config);

  if (!result.success) {
    printOperationResults(result);
  }
}

function printClientList(config: Record<string, any>): void {
  const statuses = listClientStatuses(config);
  console.log("\nClient Integrations");
  console.log("-------------------");
  for (const status of statuses) {
    const enabled = status.enabled ? "Enabled" : "Disabled";
    const managed = status.managed ? "managed by CCR" : "official config";
    const model = status.activeModel || status.modelAlias || "-";
    console.log(`${status.id.padEnd(10)} ${enabled.padEnd(8)} ${managed}`);
    console.log(`  name:  ${status.name}`);
    console.log(`  path:  ${status.configPath}`);
    console.log(`  model: ${model}`);
    if (status.details) {
      console.log(`  note:  ${status.details}`);
    }
  }
}

function validateClientArgs(args: string[], allowEmpty = false): ClientId[] {
  if (args.length === 0) {
    if (allowEmpty) return [];
    throw new Error(`No clients specified. Available clients: ${CLIENT_IDS.join(", ")}`);
  }

  const invalid = args.filter((id) => !isClientId(id));
  if (invalid.length > 0) {
    throw new Error(`Unknown client(s): ${invalid.join(", ")}`);
  }

  return args as ClientId[];
}

async function runClientOperations(
  ids: string[],
  action: "enable" | "disable" | "restore"
): Promise<ClientApplyResult> {
  const config = await readConfigFile();
  const results: ClientOperationResult[] = [];

  for (const id of validateClientArgs(ids)) {
    try {
      if (action === "enable") {
        results.push(enableClient(config, id));
      } else if (action === "restore") {
        results.push(restoreClient(config, id));
      } else {
        results.push(disableClient(config, id));
      }
    } catch (error) {
      results.push({
        id,
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await writeConfigFile(config);
  await syncGlobalProjectTakeovers(config);
  return {
    success: results.every((item) => item.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export async function handleClientsCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || "list";

  switch (subcommand) {
    case "list": {
      const config = await readConfigFile();
      printClientList(config);
      return;
    }
    case "apply": {
      const config = await readConfigFile();
      const result = applyClientSelection(config, validateClientArgs(args.slice(1), true));
      await writeConfigFile(result.config);
      await syncGlobalProjectTakeovers(result.config);
      printOperationResults(result);
      if (!result.success) process.exit(1);
      return;
    }
    case "enable":
    case "disable":
    case "restore": {
      const result = await runClientOperations(args.slice(1), subcommand);
      printOperationResults(result);
      if (!result.success) process.exit(1);
      return;
    }
    default:
      console.log(`Usage:
  ccr clients list
  ccr clients apply [client...]
  ccr clients enable claudeCode codex
  ccr clients disable codex
  ccr clients restore claudeCode`);
      process.exit(1);
  }
}
