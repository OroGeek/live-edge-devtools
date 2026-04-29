// Live Edge DevTools — VS Code Extension
// Bridges Live Server + Microsoft Edge DevTools so HTML files open
// at http://localhost:<port>/... instead of file://

import * as vscode from "vscode";
import * as http from "http";
import * as path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const LIVE_SERVER_GO_ONLINE_CMD = "extension.liveServer.goOnline";
const EDGE_DEVTOOLS_LAUNCH_CMD = "vscode-edge-devtools.launch";
const EDGE_DEVTOOLS_ATTACH_CMD = "vscode-edge-devtools.attach";

// The command ID the Microsoft Edge Tools extension uses for screencast
// (falls back to the regular launch if unavailable)
const EDGE_SCREENCAST_CMD = "vscode-edge-devtools-view.toggleScreencast";

const EDGE_EXT_ID = "ms-edgedevtools.vscode-edge-devtools";
const LIVE_SERVER_EXT_ID = "ritwickdey.liveserver";

const SETTINGS_NS = "liveEdgeDevtools";

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "liveEdgeDevtools.openWithLiveServer",
      (uri?: vscode.Uri) => openWithLiveServer(uri, "devtools"),
    ),
    vscode.commands.registerCommand(
      "liveEdgeDevtools.openScreencastWithLiveServer",
      (uri?: vscode.Uri) => openWithLiveServer(uri, "screencast"),
    ),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

// ─── Main flow ────────────────────────────────────────────────────────────────

async function openWithLiveServer(
  uri: vscode.Uri | undefined,
  mode: "devtools" | "screencast",
): Promise<void> {
  // 1. Resolve which file to open
  const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!fileUri) {
    vscode.window.showErrorMessage(
      "Live Edge DevTools: No HTML file selected or open.",
    );
    return;
  }
  if (path.extname(fileUri.fsPath).toLowerCase() !== ".html") {
    vscode.window.showWarningMessage(
      "Live Edge DevTools: Please select an HTML file.",
    );
    return;
  }

  // 2. Check both required extensions are installed
  if (
    !checkExtensionInstalled(
      EDGE_EXT_ID,
      "Microsoft Edge Tools for VS Code (ms-edgedevtools.vscode-edge-devtools)",
    )
  ) {
    return;
  }
  if (
    !checkExtensionInstalled(
      LIVE_SERVER_EXT_ID,
      "Live Server (ritwickdey.liveserver)",
    )
  ) {
    return;
  }

  // 3. Resolve the effective open mode (may prompt user if setting is 'ask')
  const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
  const settingMode = cfg.get<string>("openMode", "devtools");
  let effectiveMode: "devtools" | "screencast" = mode;
  if (settingMode === "ask" && mode === "devtools") {
    const pick = await vscode.window.showQuickPick(
      ["DevTools Panel", "Screencast Panel"],
      { placeHolder: "How do you want to open Edge?" },
    );
    if (!pick) {
      return;
    }
    effectiveMode = pick === "Screencast Panel" ? "screencast" : "devtools";
  }

  // 4. Resolve the Live Server port
  const port = getLiveServerPort(cfg);

  // 5. Build the localhost URL for this file
  const localhostUrl = buildLocalhostUrl(fileUri, port);
  if (!localhostUrl) {
    vscode.window.showErrorMessage(
      "Live Edge DevTools: Could not determine the URL. " +
        "Make sure your HTML file is inside the workspace folder.",
    );
    return;
  }

  // 6. Start Live Server (if not already running) and wait for it
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Live Edge DevTools",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Starting Live Server…" });

      const alreadyRunning = await isServerReachable(port);
      if (!alreadyRunning) {
        // Trigger Live Server — it will start serving the workspace root
        await vscode.commands.executeCommand(
          LIVE_SERVER_GO_ONLINE_CMD,
          fileUri,
        );

        // Wait until the server is actually up
        const delay = cfg.get<number>("startLiveServerDelay", 1500);
        const started = await waitForServer(port, delay, 8000);
        if (!started) {
          vscode.window.showErrorMessage(
            `Live Edge DevTools: Live Server did not start on port ${port}. ` +
              'Check your Live Server settings or try increasing "liveEdgeDevtools.startLiveServerDelay".',
          );
          return;
        }
      }

      progress.report({ message: `Opening Edge at ${localhostUrl}…` });

      // 7. Launch Edge DevTools pointing at localhost
      if (effectiveMode === "screencast") {
        await launchEdgeScreencast(localhostUrl);
      } else {
        await launchEdgeDevTools(localhostUrl);
      }
    },
  );
}

// ─── Edge DevTools launchers ──────────────────────────────────────────────────

async function launchEdgeDevTools(url: string): Promise<void> {
  try {
    // The `vscode-edge-devtools.launch` command accepts { launchUrl }
    await vscode.commands.executeCommand(EDGE_DEVTOOLS_LAUNCH_CMD, {
      launchUrl: url,
    });
  } catch {
    vscode.window.showErrorMessage(
      `Live Edge DevTools: Failed to launch Edge DevTools. ` +
        `Make sure the "Microsoft Edge Tools for VS Code" extension is enabled.`,
    );
  }
}

async function launchEdgeScreencast(url: string): Promise<void> {
  // The screencast command works differently — it works via attach to a target.
  // Best approach: launch normally first, which opens Edge at our URL.
  // The screencast can then be toggled from the targets pane.
  // As a convenience we launch devtools and notify the user.
  try {
    await vscode.commands.executeCommand(EDGE_DEVTOOLS_LAUNCH_CMD, {
      launchUrl: url,
    });
    // After the browser opens, attempt to toggle screencast view.
    // Give Edge a moment to register its targets.
    await sleep(800);
    await vscode.commands
      .executeCommand(EDGE_SCREENCAST_CMD)
      .then(undefined, () => {
        /* command may not exist in all versions — silently ignore */
      });
  } catch {
    vscode.window.showErrorMessage(
      `Live Edge DevTools: Failed to launch Edge. ` +
        `Make sure the "Microsoft Edge Tools for VS Code" extension is enabled.`,
    );
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function getLiveServerPort(cfg: vscode.WorkspaceConfiguration): number {
  // 1. Check our own override setting first
  const override = cfg.get<number>("liveServerPort", 0);
  if (override && override > 0) {
    return override;
  }

  // 2. Read Live Server's own setting
  const lsCfg = vscode.workspace.getConfiguration("liveServer.settings");
  const lsPort = lsCfg.get<number>("port", 5500);
  return lsPort > 0 ? lsPort : 5500;
}

function buildLocalhostUrl(
  fileUri: vscode.Uri,
  port: number,
): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    // No workspace: serve the file's directory as root
    return `http://localhost:${port}/${path.basename(fileUri.fsPath)}`;
  }

  // Find the workspace folder that contains this file
  const folder =
    workspaceFolders.find((f) => fileUri.fsPath.startsWith(f.uri.fsPath)) ??
    workspaceFolders[0];

  // Compute the relative path from workspace root → URL path
  const relativePath = path
    .relative(folder.uri.fsPath, fileUri.fsPath)
    .replace(/\\/g, "/"); // normalise Windows back-slashes

  return `http://localhost:${port}/${relativePath}`;
}

// ─── Network helpers ──────────────────────────────────────────────────────────

function isServerReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(
  port: number,
  initialDelay: number,
  maxWait: number,
): Promise<boolean> {
  await sleep(initialDelay);
  const deadline = Date.now() + (maxWait - initialDelay);
  while (Date.now() < deadline) {
    if (await isServerReachable(port)) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

// ─── Extension helpers ────────────────────────────────────────────────────────

function checkExtensionInstalled(
  extensionId: string,
  friendlyName: string,
): boolean {
  const ext = vscode.extensions.getExtension(extensionId);
  if (!ext) {
    vscode.window.showErrorMessage(
      `Live Edge DevTools requires ${friendlyName}. ` +
        "Please install it from the Extensions Marketplace.",
    );
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
