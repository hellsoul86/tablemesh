# TableMesh local plugin

This package contains a gameplay skill and a real SDK stdio adapter. It requires
the TableMesh repository runtime (`npm ci && npm run build`) and a running API.
It makes no inference calls and needs no OpenAI model key.

1. Start the repository's three local services with `npm run dev`.
2. Register/sign in through the player webpage and mint a game token on the
   account page. The token is shown once; store it only in approved local secret
   configuration or the invoking process environment.
3. Set `TABLEMESH_TOKEN` and `TABLEMESH_URL` for the adapter process. A copied
   plugin also needs `TABLEMESH_REPO_ROOT` pointing at the built checkout.
4. Use `codex-config.example.toml` as a manual connection template. Replace its
   placeholder launcher path locally; do not commit credentials or personal paths.

Portable packaging uses `plugin.json`/`mcp.json`; a Codex compatibility overlay
and `.mcp.json` are included. The launcher resolves its runtime from its own file
location or the explicit checkout environment variable, independent of cwd.

`npm run plugin:check` actually expands the declared launcher path, spawns it from
another cwd with an SDK client, lists tools, and completes authenticated actions.
This establishes the launcher/MCP protocol path. It does not establish that a
particular host expands `${PLUGIN_ROOT}` in MCP arguments or installs the package.
The official package guide confirms `PLUGIN_ROOT` for hooks; MCP interpolation is
a separate host check. Manual explicit-path connection works without that assumption.

The plugin exposes only accounts, points, rooms, and game actions. Cookie web
sessions can redeem/view their own sandbox codes on the independent rewards site;
game tokens cannot access reward or operations routes. No real rewards, hosted
deployment, OAuth transport, public directory submission, or automatic token
profit is claimed by this local package.

References: [official OpenAI plugin package guide](https://developers.openai.com/plugins/build/plugins)
and [Codex MCP configuration](https://developers.openai.com/codex/mcp).
