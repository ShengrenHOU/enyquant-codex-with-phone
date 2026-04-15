export async function handleConfigRoute(ctx, runtime) {
  if (ctx.path !== "/api/config") {
    return false;
  }

  if (!runtime.requireAuthorized(ctx)) {
    return true;
  }

  runtime.json(ctx, 200, {
    host: runtime.config.host,
    port: runtime.config.port,
    defaultCwd: runtime.config.defaultCwd,
    timezone: runtime.config.timezone,
    mobileCodexDefaults: {
      model: runtime.config.mobileCodexModel,
      profile: runtime.config.mobileCodexProfile,
      fullAccess: runtime.config.mobileCodexFullAccess,
      extraArgs: runtime.config.mobileCodexExtraArgs
    },
    defaultProvider: "codex",
    providers: runtime.sessionManager.providerCatalog()
  });
  return true;
}
