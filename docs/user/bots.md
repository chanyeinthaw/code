# Use bots

Each bot keeps a continuing conversation while each reply starts a fresh provider session.
Original messages remain available when older context becomes summarized. Messages sent during a reply steer that reply.
Steering messages sent while a bot is preparing join the same reply after compaction finishes.

1. Enable **Settings → Beta → Alternate layout**.
2. Open **Bots**. The first bot is created automatically on the connected primary environment.
3. Choose a provider and model in the composer, then send a message.

Open **Bots** to return to your last selected bot.
Use the bot sidebar to switch bots, or open **Settings → Bots** to manage them.
You can also switch bots and open management through **Cmd+K** on macOS or **Ctrl+K** elsewhere.
Manage bots in **Settings → Bots**. Filter by environment, or choose **All environments**.
Choose **New bot**, then enter a name and select its environment.
To move ownership, open a bot's **⋯** menu and choose **Move to another environment**.
Interrupted moves show **Resume transfer**, with **Cancel transfer** available before ownership is released.
Bot creation does not require support for threads without a project.
Each bot has its own conversation and workspace.
Rename a bot from its context menu. The new name applies to future replies, and the name change is saved in its memory.
Bots stay separate from project pickers, project search, and ordinary thread lists.
Codex 0.160.0 or newer, Claude Code, Pi, and local OpenCode support bot replies.
Each Codex instance keeps its configured home, login, models, and composer options.
Older Codex instances are disabled for bot chat. If the version cannot be verified, bot turns stop before inference starts.
Other providers are unavailable for replies because their current integrations cannot enforce the memory tool policy. Your configured native MCP servers remain available.
Files attached to a message are available through `t3_attachment_read`. Images use the provider's normal image input.

## Coordinate work

A bot delegates work to subagents by default and can start ordinary threads for ongoing work.
Subagents use the bot conversation's workspace and receive its frozen memory view with tools to recall details and read attachments.
That view stays fixed while the parent conversation continues. Ordinary threads do not inherit memory.
For work in another project, the bot starts an ordinary thread in that project.
It uses your configured providers, models, and options, and receives delegated results through T3 Code's existing notifications.
Ask explicitly when you want it to act directly using its available tools.
A bot can also show visualizations, inspect browser and device views when enabled, and track pull requests.

## Choose whether replies load instructions and skills

Open a bot's settings and use **Instructions → Load instructions and skills**. It is on by default.
When on, each reply lets its provider load the global and workspace instruction files
(`AGENTS.md`, `CLAUDE.md`) and skills it normally would. Codex then runs in the selected Codex home
instead of the bot's separate copy, and Claude Code still skips MCP servers from its settings.
When off, replies load none of them.
Bot messages and tool results can reflect what these files say, and those can enter memory.
Memory compaction never loads them. A change applies from the next reply.

## Choose the compaction model

Set **Settings → Bots → Memory compaction model** on the owning environment.
Reset this setting to use its text generation model. The reply model remains independent.
Compaction runs in the background with instructions to call no tools.
Tools are disabled where the provider supports it, including native MCP servers where possible.
Compaction continues if tool isolation cannot be confirmed. Codex still requires version 0.160.0 or newer.
A new reply waits for pending summaries before freezing its memory view.
New compaction requests for that bot wait until its reply ends. Other bots compact independently.
**Memory compaction concurrency** defaults to eight requests per provider instance across all bots
in the owning environment. Choose 2, 4, 6, or 8 requests in the same settings section. Changes apply to
subsequent requests; requests already running finish normally.

## Move a bot to another environment

Connect both environments, finish or cancel pending turns, then open **Manage bots**, select a destination, and choose **Move**.
The move carries the conversation, original messages, summaries, workspace, and attachments.
The destination uses its own providers, compaction setting, and instruction-loading setting. Select an available provider there if the previous one is unavailable.

The source stops accepting bot turns before the destination takes ownership.
If the connection breaks, reconnect both environments and choose **Resume transfer**.
You can cancel a move until the source releases ownership.

Keep the owning environment online to continue its bots from another device.
Connecting from another device does not move ownership or inference to that device.
