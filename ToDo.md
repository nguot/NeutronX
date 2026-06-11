1 test case the hien he thong minh chong phan manh order boi MEV bot => chung minh stake hoat dong tot (loadtest)
1 test case cross chain => chứng minh chia slot theo merkle tree (2 mũ) hoạt động tốt  (test lại)

1 filler là copy của alpha router nhưng có data từ các pool khác ? 
filler ban chat la mang tien minh di trade xong lay duoc tien >= so tien minh muon => filler an phan lai => van de la trade o dau 

design filler = strategy (công thức tính lãi) + source (nguon trade o dau = CoW la orderbook, Whale la vo han tien) + 1 simulate (quoter) + danh sach contract (ABI)

check token 
////////////////////////////////
Front running
1. Filler A registers (and stakes) to fill the full order.
2. An MEV bot front-runs with its own (cheap, small-bucket) registration + execute() for a tiny slice of the same order.
3. The order's remaining amount is now less than A's registered fillAmount → A's execute() reverts (can never match exactly anymore) → A gets slashed after the window, losing a much larger (100%-bucket) stake — and the bot can call slash() itself to collect the 10% reward.

This isn't about the multiplier table being "too small" — it's a logic gap (exact-amount matching + no way to adjust a registration), and a bond-size invariant wouldn't catch it.
///////////////
bash -lc 'export PATH="$PATH:/home/nguot/.foundry/bin" && cast call 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 "balanceOf(address)(uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8546'


Here are the documented steps for mksglu/context-mode — but a few things worth flagging before you run them, since this isn't a passive logging tool.

What it actually installs

- A third-party plugin marketplace (mksglu/context-mode) added to your Claude Code config
- An MCP server with 11 tools, including ctx_execute, ctx_execute_file, ctx_batch_execute — these run code in a sandbox on your machine
- 4 hooks (SessionStart, PreToolUse, PostToolUse, PreCompact) that fire on every tool call I make, rerouting output through their sandbox

That's a meaningful trust boundary — every file read, bash command, etc. in future sessions gets intercepted/processed by this third-party code before reaching me. Worth a quick look at https://github.com/mksglu/context-mode source/issues first if you haven't.

Steps (run these yourself in the Claude Code CLI)

1. Check your Claude Code version (needs ≥ v1.0.33):
claude --version
1. Update if needed: npm update -g @anthropic-ai/claude-code
2. Add the marketplace and install the plugin:
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
3. Restart Claude Code (or run /reload-plugins)
4. Verify:
/context-mode:ctx-doctor
4. All checks should show checkmarks (validates runtimes, hooks, FTS5 db, plugin registration).
5. (Optional) Add a status-bar savings indicator — edit ~/.claude/settings.json:
{
  "statusLine": { "type": "command", "command": "context-mode statusline" }
}
5. then restart.

These are Claude Code slash commands you type directly into the CLI — I can't run /plugin commands myself via Bash. If you want, I can wait here and you can paste back the ctx-doctor output if anything fails.

Sources:
- mksglu/context-mode (https://github.com/mksglu/context-mode)